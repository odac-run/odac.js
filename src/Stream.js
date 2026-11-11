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

    this.#res.setHeader('Content-Type', 'text/event-stream')
    this.#res.setHeader('Cache-Control', 'no-cache')
    this.#res.setHeader('Connection', 'keep-alive')

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
      input.on('data', chunk => this.send(chunk.toString()))
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

  send(data) {
    if (this.#closed) return false
    const message = typeof data === 'string' ? data : JSON.stringify(data)
    this.#res.write(`data: ${message}\n\n`)
    return true
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

  #pipeIterator(iterator) {
    const batchSize = 100
    const iterate = () => {
      let count = 0
      while (count < batchSize) {
        const {value, done} = iterator.next()
        if (done) {
          this.close()
          return
        }
        this.send(value)
        count++
      }
      setImmediate(iterate)
    }
    iterate()
  }

  async #pipeAsyncIterator(iterator) {
    try {
      for await (const value of iterator) {
        this.send(value)
      }
      this.close()
    } catch (err) {
      this.error(err.message)
      this.close()
    }
  }
}

module.exports = Stream
