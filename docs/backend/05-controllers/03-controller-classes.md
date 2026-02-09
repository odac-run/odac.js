## 🧩 Service Classes

You can organize your business logic into reusable classes. This is especially useful when you want to share logic between multiple methods or keep related functionality together.

We recommend placing these files in the `class/` directory.

### ❓ Service Class vs. Controller

It is important not to confuse **Service Classes** with **Class-Based Controllers**.

- **Controllers** (located in `controller/`):
    - Handle HTTP requests (Input -> Process -> Response).
    - Can be defined as Classes for better organization.
    - Are mapped to specific Routes (e.g., via `Route.get()`).

- **Service Classes** (located in `class/`):
    - Contain reusable business logic (e.g., `User.calculateReputation()`, `Mail.sendWelcome()`).
    - Are **not** directly mapped to routes.
    - Can be used by *multiple* controllers or other services.
    - Are **Request Scoped**: They are instantiated fresh for every request and attached to the request's `Odac` instance. They correspond to the life-cycle of the request.

**Rule of Thumb:** If it talks to the browser/API client, it's a **Controller**. If it processes data behind the scenes, it's a **Service Class**.

#### Creating a Service Class

Any class file placed in the `class/` directory will be automatically detected. When a request comes in, Odac creates a **new instance** of your class and passes the current request's `Odac` object to the constructor.

This means `this.Odac` inside your class gives you access to the specific request, response, authentication state, and database for *that specific user request*.

```javascript
// class/User.js
class User {
  constructor(Odac) {
    this.Odac = Odac
  }


  async getProfile() {
    const user = await this.Odac.Auth.user()
    return {
      success: true,
      user: user
    }
  }

  async updateProfile() {
    const validator = this.Odac.validator()
    validator.post('name').required().min(3)
    validator.post('email').required().email()

    if (await validator.error()) {
      return validator.result()
    }

    const name = await this.Odac.request('name')
    const email = await this.Odac.request('email')

    // Update user in database
    await this.Odac.DB.users.where('id', this.Odac.Auth.user().id).update({
        name: name,
        email: email
    })

    return {
      success: true,
      message: 'Profile updated successfully'
    }
  }
}

module.exports = User
```

#### Naming Collisions

If your class name conflicts with a built-in Odac service (like `Mail`, `DB`, `Auth`), it will be automatically placed under `Odac.App` namespace to prevent errors.

Example: `class/Mail.js` (conflicts with core Mail) -> `Odac.App.Mail`

#### Accessing Services in Controllers
 
 Since Service classes are attached to the `Odac` instance for each request, you can access them directly by their file name.
 
 ```javascript
 // controller/get/profile.js
 module.exports = async function (Odac) {
   // Odac.User is a fresh instance of the User class dedicated to this request
   const profile = await Odac.User.getProfile()
   
   return Odac.return(profile)
 }
 ```
 
 #### Benefits of Service Classes
 
 - **Organization**: Group related business logic together in `class/`
 - **Reusability**: Share logic between different controllers and routes
 - **Context Awareness**: The `Odac` request object is injected automatically, so your services know about the current user and request.
 - **Separation of Concerns**: Keep your Controllers lightweight by moving heavy logic to Services.
