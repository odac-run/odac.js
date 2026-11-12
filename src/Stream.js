class Stream {
  // Open streams on this worker. An SSE response never ends on its own, so it
  // keeps server.close() from calling back; shutdown ends them through here.
  static #open = new Set()

  /**
   * Ends every open SSE stream on this worker.
   *
   * Why: graceful shutdown waits for server.close(), which waits for every
   * socket. A live event stream would hold the worker until the primary's
   * hard timeout kills it and skips the final write-buffer flush. EventSource
   * clients reconnect on their own, reaching a live worker.
   */
  static closeAll() {
    for (const stream of [...Stream.#open]) stream.close()
  }

  #heartbeat
  #req
  #res
  #closed = false
  #odac

  constructor(req, res, input, odac) {
    this.#req = req
    this.#res = res
    this.#odac = odac
    this.#init()
    this.#handleInput(input)
  }

  #init() {
    if (this.#res.headersSent || this.#res.writableEnded) {
      this.#closed = true
      return
    }

    this.#req.setTimeout(0)
    this.#res.setTimeout(0)
    Stream.#open.add(this)

    this.#writeHead()

    this.#heartbeat = setInterval(() => {
      if (!this.#closed) {
        this.#res.write(': heartbeat\n\n')
      }
    }, 30000)

    const handleClose = () => {
      this.close()
    }

    this.#req.on('close', handleClose)
    this.#res.on('close', handleClose)
  }

  // Headers go out through the Request so everything queued on it before the stream opened
  // (status, custom headers and Set-Cookie, e.g. rotated auth tokens) reaches the client.
  // Writing them on the raw response would bypass that queue and silently drop it.
  #writeHead() {
    const request = this.#odac?.Request
    if (!request || typeof request.print !== 'function') {
      this.#res.setHeader('Content-Type', 'text/event-stream')
      this.#res.setHeader('Cache-Control', 'no-cache')
      this.#res.setHeader('Connection', 'keep-alive')
      return
    }

    request.header('Content-Type', 'text/event-stream')
    request.header('Cache-Control', 'no-cache')
    request.header('Connection', 'keep-alive')
    request.print()
  }

  #handleInput(input) {
    if (input === undefined) {
      return
    }

    if (typeof input === 'function') {
      const result = input(
        data => this.send(data),
        () => this.close(),
        this
      )

      if (result && typeof result[Symbol.asyncIterator] === 'function') {
        this.#pipeAsyncIterator(result)
      } else if (result && typeof result.next === 'function') {
        this.#pipeIterator(result)
      } else if (typeof result === 'function') {
        this.on('close', result)
      }

      return
    }

    if (input && typeof input[Symbol.asyncIterator] === 'function') {
      this.#pipeAsyncIterator(input)
      return
    }

    if (input && typeof input.next === 'function') {
      this.#pipeIterator(input)
      return
    }

    if (Array.isArray(input) || (input && typeof input[Symbol.iterator] === 'function')) {
      for (const value of input) {
        this.send(value)
      }
      this.close()
      return
    }

    if (input && typeof input.then === 'function') {
      input
        .then(data => {
          this.send(data)
          this.close()
        })
        .catch(err => {
          this.error(err.message)
          this.close()
        })
      return
    }

    if (input && typeof input.pipe === 'function') {
      input.on('data', chunk => {
        if (this.#closed) return input.destroy?.()
        if (this.#write(chunk.toString()) && typeof input.pause === 'function') {
          input.pause()
          this.#drained().then(() => input.resume())
        }
      })
      this.on('close', () => input.destroy?.())
      input.on('end', () => this.close())
      input.on('error', err => {
        this.error(err.message)
        this.close()
      })
      return
    }

    this.send(input)
    this.close()
  }

  /**
   * Sends one SSE message.
   * Why: every line of the payload gets its own `data:` field. Writing a multi-line string
   * as one field broke the frame, and a payload containing a blank line followed by
   * `event:`/`data:` lines injected a separate, attacker-shaped event into the stream.
   * @returns {boolean} false once the stream is closed.
   */
  send(data) {
    if (this.#closed) return false
    this.#write(data)
    return true
  }

  // Writes one message and reports whether the socket buffer is full (backpressure).
  #write(data) {
    // Readable streams arrive here through async iteration as Buffers; send their text, not
    // the {"type":"Buffer"} JSON form.
    if (Buffer.isBuffer(data)) data = data.toString()
    const message = typeof data === 'string' ? data : String(JSON.stringify(data))
    return this.#res.write(`data: ${message.split(/\r\n|\r|\n/).join('\ndata: ')}\n\n`) === false
  }

  // Resolves once the response can take more data or the stream has closed.
  #drained() {
    if (this.#closed || this.#res.writableEnded) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        this.#res.off?.('drain', done)
        this.#res.off?.('close', done)
        resolve()
      }
      this.#res.once('drain', done)
      this.#res.once('close', done)
    })
  }

  error(message) {
    return this.send({error: message})
  }

  on(event, callback) {
    if (event === 'close') {
      this.#req.on('close', callback)
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    clearInterval(this.#heartbeat)
    Stream.#open.delete(this)
    if (!this.#res.writableEnded) {
      this.#res.end()
    }
    if (this.#odac && typeof this.#odac.cleanup === 'function') {
      this.#odac.cleanup()
    }
  }

  // Sync iterators are pumped in batches so a long one does not block the event loop, and
  // stop at a full socket buffer until it drains, so a slow client cannot make the worker
  // buffer the whole sequence in memory.
  #pipeIterator(iterator) {
    const batchSize = 100
    const iterate = async () => {
      try {
        let count = 0
        while (count < batchSize) {
          if (this.#closed) return
          const {value, done} = iterator.next()
          if (done) return this.close()
          count++
          if (this.#write(value)) {
            await this.#drained()
            count = 0
          }
        }
        setImmediate(iterate)
      } catch (err) {
        this.error(err.message)
        this.close()
      }
    }
    iterate()
  }

  async #pipeAsyncIterator(iterator) {
    try {
      for await (const value of iterator) {
        if (this.#closed) break
        if (this.#write(value)) await this.#drained()
      }
      this.close()
    } catch (err) {
      this.error(err.message)
      this.close()
    }
  }
}

module.exports = Stream
