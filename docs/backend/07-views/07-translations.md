## 🌍 Translations (i18n)

Odac provides built-in internationalization (i18n) support, allowing you to create multi-language applications easily.

### Basic Translation

```html
<odac translate>Welcome</odac>
<odac translate>Hello World</odac>
<odac translate>Login</odac>
```

The text inside the tag is used as the translation key. Odac looks up this key in your language files.

### Translation Files

Translation files are stored in `storage/language/`, one JSON file per two-letter language code:

```
storage/
└── language/
    ├── en.json
    ├── tr.json
    └── de.json
```

**Example: `storage/language/en.json`**
```json
{
  "Welcome": "Welcome",
  "Hello World": "Hello World",
  "Login": "Login",
  "Logout": "Logout"
}
```

**Example: `storage/language/tr.json`**
```json
{
  "Welcome": "Hoş Geldiniz",
  "Hello World": "Merhaba Dünya",
  "Login": "Giriş Yap",
  "Logout": "Çıkış Yap"
}
```

### Missing Keys

In development (`debug` mode) a key without an entry is added to **every** language file at once: the default language gets the key itself as its value, every other language gets `""` (not translated yet). Production does not write to disk; set `"lang": {"collect": true}` in `odac.json` to collect keys there too.

```json
// storage/language/en.json (default)     // storage/language/tr.json
{                                          {
    "Login": "Login",                          "Login": "Giriş Yap",
    "Logout": "Logout"                         "Logout": ""
}                                          }
```

All language files therefore list the same entries in the same order (sorted by key), which keeps them easy to compare and keeps diffs small. Writes from several workers are serialized, and a language file that is not valid JSON (for example while you are editing it) is never overwritten; a warning is logged instead. Language files are loaded once per worker and re-read when they change on disk.

To remove a key, use `odac lang:prune` (see [Managing Language Files](#managing-language-files)); deleting it from a single file by hand is undone the next time keys are synced, because the other files still have it.

#### Spotting Missing Translations

- An empty string marks a translation that is still missing; it is served from the default language meanwhile.
- In debug mode each missing translation is logged once as a `WARN` (`{"message": "Missing translation", "lang": "tr", "key": "Logout"}`).
- Set `"lang": {"highlightMissing": true}` to mark text served from the fallback on the page itself, e.g. `⟦Logout⟧`. It only takes effect in debug mode.

### Context: Same Text, Different Meanings

The same source text can need different translations depending on where it is used. In Turkish, "Gül" is both the flower ("Rose") and the verb ("Smile"); "Open" can be a button label or a status. Add a `context` to tell them apart:

```html
<odac translate context="flower">Gül</odac>
<odac translate context="verb">Gül</odac>
```

```javascript
// Controller
Odac.__x('Gül', 'verb')            // "Smile"
Odac.__x('%s1 gül', 'flower', 3)   // placeholders come after the context
```

The context is part of the entry's identity. In the language file the key holds an object of context → translation, where `""` is the variant used without a context:

```json
// storage/language/en.json
{
  "Gül": {
    "": "Gül",
    "flower": "Rose",
    "verb": "Smile"
  }
}
```

Keys without a context stay plain strings. A missing context variant falls back to the same variant in the default language, then to the key, never to another context's translation. Keep contexts short and descriptive (`button`, `status`, `verb`): translators read them to decide what the text means. Contexts are capped at 100 characters.

### Translations with Placeholders

Use nested `<odac>` tags to insert dynamic values:

```html
<odac translate>Hello <odac var="user.name" /></odac>
```

**How it works:**
1. The content becomes: `Hello %s1`
2. Odac looks up this key in the language file
3. `%s1` is replaced with the actual value

**Language file:**
```json
{
  "Hello %s1": "Hello %s1",
  "Hello %s1": "Merhaba %s1"
}
```

### Multiple Placeholders

```html
<odac translate>
  <odac var="user.firstName" /> <odac var="user.lastName" />
</odac>
```

This creates the key `%s1 %s2` and replaces both placeholders.

**Language file:**
```json
{
  "%s1 %s2": "%s1 %s2",
  "%s1 %s2": "%s1 %s2"
}
```

### String Literals in Translations

```html
<odac translate>Hello <odac>John</odac>, how are you?</odac>
```

**Language file:**
```json
{
  "Hello %s1, how are you?": "Hello %s1, how are you?",
  "Hello %s1, how are you?": "Merhaba %s1, nasılsın?"
}
```

### Raw HTML in Translations

By default, translations are HTML-escaped for security. Use `raw` attribute when your translation contains HTML:

```html
<!-- Normal translation (HTML will be encoded) -->
<odac translate>Click <a href="/help">here</a> for help</odac>
<!-- Output: Click &lt;a href="/help"&gt;here&lt;/a&gt; for help -->

<!-- Raw translation (HTML preserved) -->
<odac translate raw>Click <a href="/help">here</a> for help</odac>
<!-- Output: Click <a href="/help">here</a> for help -->
```

**Language file:**
```json
{
  "Click <a href=\"/help\">here</a> for help": "Click <a href=\"/help\">here</a> for help",
  "Click <a href=\"/help\">here</a> for help": "Yardım için <a href=\"/help\">buraya</a> tıklayın"
}
```

### Raw Translations with Placeholders

```html
<odac translate raw>
  Welcome <strong><odac var="user.name" /></strong>!
</odac>
```

**Language file:**
```json
{
  "Welcome <strong>%s1</strong>!": "Welcome <strong>%s1</strong>!",
  "Welcome <strong>%s1</strong>!": "Hoş geldin <strong>%s1</strong>!"
}
```

### Practical Examples

#### Navigation Menu

```html
<nav>
  <a href="/"><odac translate>Home</odac></a>
  <a href="/products"><odac translate>Products</odac></a>
  <a href="/about"><odac translate>About Us</odac></a>
  <a href="/contact"><odac translate>Contact</odac></a>
</nav>
```

#### Welcome Message

```html
<div class="welcome">
  <h1>
    <odac translate>Welcome back, <odac var="user.name" />!</odac>
  </h1>
  <p>
    <odac translate>You have <odac var="notifications.length" /> new notifications</odac>
  </p>
</div>
```

**Language file:**
```json
{
  "Welcome back, %s1!": "Welcome back, %s1!",
  "Welcome back, %s1!": "Tekrar hoş geldin, %s1!",
  "You have %s1 new notifications": "You have %s1 new notifications",
  "You have %s1 new notifications": "%s1 yeni bildiriminiz var"
}
```

#### Form Labels and Buttons

```html
<form>
  <div class="form-group">
    <label><odac translate>Email Address</odac></label>
    <input type="email" name="email" placeholder="<odac translate>Enter your email</odac>">
  </div>
  
  <div class="form-group">
    <label><odac translate>Password</odac></label>
    <input type="password" name="password" placeholder="<odac translate>Enter your password</odac>">
  </div>
  
  <button type="submit">
    <odac translate>Login</odac>
  </button>
  
  <a href="/forgot-password">
    <odac translate>Forgot your password?</odac>
  </a>
</form>
```

#### Product Information

```html
<div class="product">
  <h2><odac var="product.name" /></h2>
  
  <p class="price">
    <odac translate>Price: $<odac var="product.price" /></odac>
  </p>
  
  <odac:if condition="product.stock > 0">
    <p class="stock">
      <odac translate><odac var="product.stock" /> units in stock</odac>
    </p>
  <odac:else>
    <p class="out-of-stock">
      <odac translate>Out of stock</odac>
    </p>
  </odac:if>
  
  <button>
    <odac translate>Add to Cart</odac>
  </button>
</div>
```

**Language file:**
```json
{
  "Price: $%s1": "Price: $%s1",
  "Price: $%s1": "Fiyat: $%s1",
  "%s1 units in stock": "%s1 units in stock",
  "%s1 units in stock": "Stokta %s1 adet",
  "Out of stock": "Out of stock",
  "Out of stock": "Stokta yok",
  "Add to Cart": "Add to Cart",
  "Add to Cart": "Sepete Ekle"
}
```

#### Error Messages

```html
<odac:if condition="errors">
  <div class="error-box">
    <odac:if condition="errors.email">
      <p><odac translate>Invalid email address</odac></p>
    </odac:if>
    
    <odac:if condition="errors.password">
      <p><odac translate>Password must be at least 8 characters</odac></p>
    </odac:if>
  </div>
</odac:if>
```

#### Rich Text with HTML

```html
<div class="notice">
  <odac translate raw>
    By clicking "Register", you agree to our 
    <a href="/terms">Terms of Service</a> and 
    <a href="/privacy">Privacy Policy</a>.
  </odac>
</div>
```

**Language file:**
```json
{
  "By clicking \"Register\", you agree to our <a href=\"/terms\">Terms of Service</a> and <a href=\"/privacy\">Privacy Policy</a>.": "By clicking \"Register\", you agree to our <a href=\"/terms\">Terms of Service</a> and <a href=\"/privacy\">Privacy Policy</a>.",
  "By clicking \"Register\", you agree to our <a href=\"/terms\">Terms of Service</a> and <a href=\"/privacy\">Privacy Policy</a>.": "\"Kayıt Ol\" butonuna tıklayarak <a href=\"/terms\">Hizmet Şartlarımızı</a> ve <a href=\"/privacy\">Gizlilik Politikamızı</a> kabul etmiş olursunuz."
}
```

### Supported Languages

A request is only ever served in a language the application has. Without configuration, these are the languages with a file in `storage/language/` plus `lang.default`. To list them explicitly, set `lang.supported` in `odac.json`. The list is then a strict whitelist: other files are ignored, and the default language is always included.

```json
{
  "lang": {
    "default": "en",
    "supported": ["en", "tr", "de"]
  }
}
```

A visitor who asks for an unsupported language gets the default one. Key collection never creates a file for a language a client asked for. To add a language, create its file (`storage/language/fr.json` containing `{}` is enough) or add it to `lang.supported`.

### Missing Translations and Fallback

A key without a translation in the active language is served in the default language, and if that has no translation either, as the key itself. An empty string in a language file means "not translated yet":

```json
// storage/language/tr.json
{
  "nav.home": "Ana Sayfa",
  "nav.about": ""
}
```

Here `nav.about` is served from `en.json` until it is translated.

### Setting the Language

The language is chosen in this order:

1. The code passed to `Odac.Lang.set()`, if it is supported.
2. The most preferred supported language of the `Accept-Language` header (q values respected, e.g. `de-DE,de;q=0.9,tr;q=0.8` picks `tr` when there is no `de.json`).
3. `lang.default` in `odac.json`, then `en`.

You can override it in your controller:

```javascript
// Controller
module.exports = async function(Odac) {
  // Set language from user preference
  if (await Odac.Auth.check()) Odac.Lang.set(Odac.Auth.user('language'))

  // Or from query parameter
  const lang = Odac.Request.get('lang')
  if (lang) Odac.Lang.set(lang)

  Odac.View.skeleton('main').set('content', 'home')
}
```

`Odac.Lang.set()` accepts only two-letter codes of supported languages; anything else falls back as described above. `Odac.Lang.current()` returns the active code.

### Using Translation Helper in Controllers

You can also use translations in your controllers:

```javascript
module.exports = async function(Odac) {
  const message = Odac.__('Welcome back, %s!', user.name)
  
  Odac.set('message', message)
  Odac.View.skeleton('main').set('content', 'dashboard')
}
```

### Best Practices

1. **Use descriptive keys**: Make translation keys meaningful and context-aware
2. **Keep keys consistent**: Use the same key for the same text across your app
3. **Organize language files**: Group related translations together
4. **Escape HTML carefully**: Only use `raw` with trusted content
5. **Test all languages**: Ensure translations work correctly in all supported languages
6. **Handle missing translations**: Provide fallback values

**Good language file structure:**
```json
{
  "nav.home": "Home",
  "nav.products": "Products",
  "nav.about": "About",
  "form.email": "Email Address",
  "form.password": "Password",
  "form.submit": "Submit",
  "error.invalid_email": "Invalid email address",
  "error.required_field": "This field is required"
}
```

**Security Warning:**
- Never use `raw` with user-generated content
- Always validate and sanitize user input before translation
- Be careful with HTML in translation strings

### Common Patterns

#### Pluralization

```html
<odac:if condition="count === 1">
  <odac translate><odac var="count" /> item</odac>
<odac:else>
  <odac translate><odac var="count" /> items</odac>
</odac:if>
```

#### Date Formatting

```javascript
// Controller
const formattedDate = new Date(date).toLocaleDateString(Odac.Lang.current())
Odac.set('date', formattedDate)
```

```html
<p><odac translate>Last updated: <odac var="date" /></odac></p>
```
