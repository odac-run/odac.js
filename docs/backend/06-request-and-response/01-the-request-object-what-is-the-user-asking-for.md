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

The ODAC Proxy passes the visitor's address and TLS state in `X-Odac-Connection-RemoteAddress` and `X-Odac-Connection-Ssl`. These headers are only honoured when the connection comes from a trusted proxy; otherwise `ip` and `ssl` describe the direct connection. By default loopback and private networks (`127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local, `fc00::/7`) are trusted, which covers the ODAC Proxy on the same host or on a container network.

```json
{
  "request": {
    "trustedProxies": ["loopback", "10.20.0.0/16"]
  }
}
```

Entries can be IP addresses, CIDR ranges or the names `loopback` and `private`; `[]` trusts no proxy. A request that arrives on the ODAC Proxy's unix socket (`ODAC_PROXY_SOCKET`, see [Running Behind the ODAC Proxy](../01-overview/03-development-server.md#running-behind-the-odac-proxy)) has no peer address and is always treated as the proxy, whatever this list says; only the proxy can reach that socket. If you run behind a different reverse proxy on a trusted address (e.g. nginx on localhost), it must overwrite both headers, for example `proxy_set_header X-Odac-Connection-RemoteAddress $remote_addr;`, or a client can still set them.

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
