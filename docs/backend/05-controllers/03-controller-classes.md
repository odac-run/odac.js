## 🧩 Service Classes

You can organize your business logic into reusable classes. This is especially useful when you want to share logic between multiple methods or keep related functionality together.

We recommend placing these files in the `class/` directory.

#### Creating a Service Class

Any class file placed in the `class/` directory will be automatically loaded and available on the `Odac` object. The class receives the global `Odac` request instance in its constructor, giving you access to all request-scoped services:

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

Service classes are automatically instantiated for each request and attached to the `Odac` object using the file name. You can access them from any controller:

```javascript
// controller/get/profile.js
module.exports = async function (Odac) {
  // Access your User class via Odac.User
  const profile = await Odac.User.getProfile()
  
  return Odac.return(profile)
}
```

#### Benefits of Service Classes

- **Organization**: Group related business logic together in `class/`
- **Reusability**: Share logic between different controllers and routes
- **Context**: The `Odac` object is injected, providing access to `Auth`, `DB`, `Request`, etc.
- **Separation of Concerns**: Keep your Controllers lightweight by moving heavy logic to Services.
