## 🏗️ How to Build a Controller

A controller is just a JavaScript module that exports a function or a Class. This function automatically gets the magical `Odac` context object we talked about in the overview.

#### Class-Based Controllers (Professional & Recommended)

For professional applications, we **strongly recommend** using Class-Based Controllers. This approach allows you to group related actions (like all User-related or Product-related logic) into a single file in the `controller/` directory, keeping your project organized.

**Example: `controller/User.js`**

```javascript
class User {
  // Access this via 'User@index'
  index(Odac) {
    return Odac.View.make('user.list', {
      title: 'User List'
    })
  }

  // Access this via 'User@show'
  show(Odac) {
    const id = Odac.Request.input('id')
    // Fetch user logic...
    return Odac.return({ id: id, name: 'John Doe' })
  }

  // Access this via 'User@store'
  store(Odac) {
    // Save user logic...
    return Odac.return({ success: true })
  }
}

module.exports = User
```

When using this structure, you define your routes using the `ControllerName@MethodName` syntax:

```javascript
Odac.Route.get('/users', 'User@index')
Odac.Route.get('/users/{id}', 'User@show')
Odac.Route.post('/users', 'User@store')
```

The framework automatically instantiates your Controller class and calls the specified method with the `Odac` instance passed as an argument.

#### specific Function Controllers (Basic)

For very simple or single-purpose routes, you can export a single function.

Check out this basic example from `controller/page/index.js`:

```javascript
// This function is our controller!
module.exports = function (Odac) {
  // It simply returns a string.
  return 'Welcome to my awesome Odac server!'
}
```

This simple function is responsible for handling the homepage route (`/`). When it runs, it just sends a simple string back to the user's browser.

