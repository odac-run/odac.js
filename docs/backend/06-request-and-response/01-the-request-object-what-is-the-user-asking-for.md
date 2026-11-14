## 📥 The Request Object

The `Odac.Request` object contains information about the user's incoming request.

### Getting Request Parameters

#### Using Odac.request() (Recommended)

The easiest way to get request parameters is using `Odac.request()`:

```javascript
module.exports = async function (Odac) {
  // Get parameter from GET or POST automatically
  const userName = await Odac.request('name')
  const userId = await Odac.request('id')
  
  return `Hello ${userName}!`
}
```

**Specify Method (Optional):**

```javascript
module.exports = async function (Odac) {
  // Get from GET parameters only
  const searchQuery = await Odac.request('q', 'GET')
  
  // Get from POST parameters only
  const formName = await Odac.request('name', 'POST')
  
  return `Searching for: ${searchQuery}`
}
```

#### Direct Access

You can also access request data directly:

```javascript
module.exports = function (Odac) {
  // GET parameters (URL query string like ?id=123)
  const userId = Odac.Request.get('id')
  
  // POST parameters (form data)
  const userName = Odac.Request.post('name')
  
  return `User: ${userName}`
}
```

### Request Properties

*   `Odac.Request.method` - HTTP method ('GET', 'POST', etc.)
*   `Odac.Request.url` - Full URL the user visited
*   `Odac.Request.host` - Website's hostname
*   `Odac.Request.ip` - User's IP address
*   `Odac.Request.ssl` - Whether connection is SSL/HTTPS

#### Client IP behind a proxy

The ODAC Proxy passes the visitor's address and TLS state in `X-Odac-Connection-RemoteAddress` and `X-Odac-Connection-Ssl`, and signs both in `X-Odac-Connection-Signature` with a key only it and your app hold (`ODAC_PROXY_KEY`). The headers are honoured only when they provably come from the proxy or a proxy you trust; otherwise they are removed and `ip` and `ssl` describe the direct connection. All three headers are removed from `req.headers` either way.

Two things always prove the proxy, whatever `request.trustedProxies` says:

- **The proxy's unix socket.** Only the proxy can reach it (`ODAC_PROXY_SOCKET`, see [Running Behind the ODAC Proxy](../01-overview/03-development-server.md#running-behind-the-odac-proxy)).
- **A valid signature.** The framework checks it against the method, `Host`, URL and both headers, and refuses one more than 60 seconds old.

Otherwise it depends on how the app runs. ODAC sets `ODAC_APP=true` for every app it runs:

| | `request.trustedProxies` not set | `request.trustedProxies` set |
|---|---|---|
| **Under ODAC, with `ODAC_PROXY_KEY`** | Nobody else: an unsigned request is not the proxy, even from a private address | The listed peers too |
| **Under ODAC, without a key** (a server older than signing, or an app started before the server was updated) | Loopback and private networks (`127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local, `fc00::/7`), which covers the proxy's TCP path | Exactly the list |
| **Not under ODAC** | Nobody | Exactly the list |

```json
{
  "request": {
    "trustedProxies": ["loopback", "10.20.0.0/16"]
  }
}
```

Entries can be IP addresses, CIDR ranges or the names `loopback` and `private`; `[]` trusts no proxy over TCP.

- **Standalone or behind your own reverse proxy:** nothing is trusted by default, so a client cannot pick its IP or fake HTTPS, even through a Docker published port where the peer is the private bridge gateway. To use a proxy of your own (e.g. nginx on localhost), list its address in `trustedProxies` and make it overwrite both headers, for example `proxy_set_header X-Odac-Connection-RemoteAddress $remote_addr;`, or a client can still set them.
- **Under ODAC:** a published port or a neighbour container on the same network reaches the app's TCP port directly, but it cannot sign, so it cannot pick its IP or fake HTTPS. The key reaches a container when it starts: an app that was running before the server was updated falls back to trusting private addresses until its next restart.
- **ODAC tunnels** are signed like the proxy: the ODAC server forwarding the tunnel signs the visitor's address and TLS state as ODAC Cloud reported them, so `ip` and `ssl` describe the visitor.

### Request Headers

```javascript
module.exports = function (Odac) {
  const userAgent = Odac.Request.header('user-agent')
  const contentType = Odac.Request.header('content-type')
  
  return `Browser: ${userAgent}`
}
```

### Complete Example

```javascript
module.exports = async function (Odac) {
  // Get request parameters
  const productId = await Odac.request('id')
  const quantity = await Odac.request('quantity') || 1
  
  // Check request method
  if (Odac.Request.method === 'POST') {
    // Handle form submission
    const result = await processOrder(productId, quantity)
    return { success: true, orderId: result.id }
  }
  
  // Show product page
  Odac.set({
    productId: productId,
    quantity: quantity
  })
  
  Odac.View.set({
    skeleton: 'main',
    content: 'product.detail'
  })
}
```

### Session Data

You can store data in the current user's session using `Odac.session()`. This data persists across requests.

```javascript
module.exports = async function (Odac) {
  // Set a session value
  Odac.session('cart_id', 12345)
  
  // Get a session value
  const cartId = Odac.session('cart_id')
  
  // Remove a session value
  Odac.session('cart_id', null)
}
```
