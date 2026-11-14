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

Translation files are stored in `lang/` in the project root, one JSON file per language code (`en.json`, `tr.json`, `pt-BR.json`; see [Regional Languages](#regional-languages)):

```
lang/
├── en.json
├── tr.json
└── de.json
```

They are source files: commit them with the rest of the project. (`storage/` holds runtime data and is git-ignored.) To keep them elsewhere, set [`lang.path`](#configuration).

**Example: `lang/en.json`**
```json
{
  "Welcome": "Welcome",
  "Hello World": "Hello World",
  "Login": "Login",
  "Logout": "Logout"
}
```

**Example: `lang/tr.json`**
```json
{
  "Welcome": "Hoş Geldiniz",
  "Hello World": "Merhaba Dünya",
  "Login": "Giriş Yap",
  "Logout": "Çıkış Yap"
}
```

### Configuration

Translations work without any configuration. Every setting lives under `lang` in `odac.json`:

```json
{
  "lang": {
    "default": "tr",
    "supported": ["tr", "en", "de"],
    "path": "lang",
    "collect": false,
    "keep": ["status.*", "Some exact key"],
    "highlightMissing": true
  }
}
```

| Setting | Type | Default | Purpose |
|---------|------|---------|---------|
| `default` | string | `"en"` | The fallback language, and the language your keys are written in. Missing translations are served from it. Set it when your site is not in English; it also makes ODAC write `<html lang>` (see [The Page Language](#the-page-language)). Case-insensitive (`pt_br` means `pt-BR`); a value that is not a [language code](#regional-languages) falls back to `en`. |
| `supported` | string[] | not set: the files in the language directory | Strict whitelist of the languages a request may be served in. Other language files are ignored, `default` is always included, and entries that are not language codes are dropped. See [Supported Languages](#supported-languages). |
| `path` | string | `"lang"` | The directory language files are read from and written to; a relative path is resolved against the project root. For example a volume that is updated in production while the application directory stays read-only. Both the app and `odac lang:*` use it. A value that is not a non-empty string is ignored with a warning. |
| `collect` | boolean | `debug` | Adds keys missing from the language files while the app runs. `true` enables it in production, `false` disables it in debug mode too. See [Missing Keys](#missing-keys). |
| `keep` | string[] | `[]` | Keys `odac lang:check` and `lang:prune` must treat as used: exact keys, or prefixes ending in `*`. For keys built at runtime. See [Keys Built at Runtime](#keys-built-at-runtime). |
| `highlightMissing` | boolean | `false` | Debug mode only: renders text served from the default language as `⟦text⟧`. See [Spotting Missing Translations](#spotting-missing-translations). |

#### Moving From `storage/language/`

Earlier versions kept language files in `storage/language/`. When `lang/` does not exist and `lang.path` is not set, ODAC still reads and writes `storage/language/`, and logs once per worker:

```json
{"level": "WARN", "message": "Language files are read from the deprecated storage/language/; move them to lang/ or set lang.path", "dir": "storage/language"}
```

`odac lang:*` prints the same notice. Move the directory and drop its exception from `.gitignore`:

```bash
git mv storage/language lang
```

```gitignore
storage/
```

Support for `storage/language/` will be removed in a future major version.

### Missing Keys

In development (`debug` mode) a key without an entry is added to **every** language file at once: the default language gets the key itself as its value, every other language gets `""` (not translated yet). Production does not write to disk; set `"lang": {"collect": true}` in `odac.json` to collect keys there too.

```json
// lang/en.json (default)     // lang/tr.json
{                              {
    "Login": "Login",              "Login": "Giriş Yap",
    "Logout": "Logout"             "Logout": ""
}                              }
```

All language files therefore list the same entries in the same order (sorted by key), which keeps them easy to compare and keeps diffs small. Writes from several workers are serialized, and a language file that is not valid JSON (for example while you are editing it) is never overwritten; a warning is logged instead.

### Editing Language Files on a Running App

Language files can be edited while the app runs, by hand, through an upload or from an admin panel, with no restart and no cache to clear. Each worker loads every language file at startup and checks every 2 seconds, in the background, whether one changed on disk, so an edit is served within about 2 seconds. A language file added while the app runs is picked up the same way.

- **Server-rendered text** uses the new translations once the changed file has been read; the request that notices the change is still served the previous version, so lookups never wait for the disk.
- **Browser code** (`view/js/`) gets them on the next AJAX navigation, as on a full page load.
- **Pages cached with `Odac.cache()`** are refreshed by the ODAC Proxy's background revalidation when their content changes, before their TTL runs out.

A file that is not valid JSON (a typo, or a file read while it was still being written) does not take the translations down. ODAC keeps serving the last valid version of that language and logs a warning once per broken version of the file:

```json
{"level": "WARN", "message": "Language file is not valid JSON; serving its last valid version", "lang": "tr"}
```

It reads the file again on every check, so the fix is served as soon as the file is valid again. A file that cannot be read at all (permissions) is handled the same way, with `Language file could not be read`. Deleting a language file is not an error: its keys are then served from the default language.

When a panel or script writes language files, write them atomically (write a temporary file, then rename it over the original), so no worker ever reads half a file.

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
// lang/en.json
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

**Language files:**
```json
// lang/en.json
{
  "Hello %s1": "Hello %s1"
}
```

```json
// lang/tr.json
{
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

**Language files:**
```json
// lang/en.json
{
  "%s1 %s2": "%s1 %s2"
}
```

```json
// lang/tr.json
{
  "%s1 %s2": "%s1 %s2"
}
```

### String Literals in Translations

```html
<odac translate>Hello <odac>John</odac>, how are you?</odac>
```

**Language files:**
```json
// lang/en.json
{
  "Hello %s1, how are you?": "Hello %s1, how are you?"
}
```

```json
// lang/tr.json
{
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

**Language files:**
```json
// lang/en.json
{
  "Click <a href=\"/help\">here</a> for help": "Click <a href=\"/help\">here</a> for help"
}
```

```json
// lang/tr.json
{
  "Click <a href=\"/help\">here</a> for help": "Yardım için <a href=\"/help\">buraya</a> tıklayın"
}
```

### Raw Translations with Placeholders

```html
<odac translate raw>
  Welcome <strong><odac var="user.name" /></strong>!
</odac>
```

**Language files:**
```json
// lang/en.json
{
  "Welcome <strong>%s1</strong>!": "Welcome <strong>%s1</strong>!"
}
```

```json
// lang/tr.json
{
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

**Language files:**
```json
// lang/en.json
{
  "Welcome back, %s1!": "Welcome back, %s1!",
  "You have %s1 new notifications": "You have %s1 new notifications"
}
```

```json
// lang/tr.json
{
  "Welcome back, %s1!": "Tekrar hoş geldin, %s1!",
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

**Language files:**
```json
// lang/en.json
{
  "Price: $%s1": "Price: $%s1",
  "%s1 units in stock": "%s1 units in stock",
  "Out of stock": "Out of stock",
  "Add to Cart": "Add to Cart"
}
```

```json
// lang/tr.json
{
  "Price: $%s1": "Fiyat: $%s1",
  "%s1 units in stock": "Stokta %s1 adet",
  "Out of stock": "Stokta yok",
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

**Language files:**
```json
// lang/en.json
{
  "By clicking \"Register\", you agree to our <a href=\"/terms\">Terms of Service</a> and <a href=\"/privacy\">Privacy Policy</a>.": "By clicking \"Register\", you agree to our <a href=\"/terms\">Terms of Service</a> and <a href=\"/privacy\">Privacy Policy</a>."
}
```

```json
// lang/tr.json
{
  "By clicking \"Register\", you agree to our <a href=\"/terms\">Terms of Service</a> and <a href=\"/privacy\">Privacy Policy</a>.": "\"Kayıt Ol\" butonuna tıklayarak <a href=\"/terms\">Hizmet Şartlarımızı</a> ve <a href=\"/privacy\">Gizlilik Politikamızı</a> kabul etmiş olursunuz."
}
```

### Supported Languages

A request is only ever served in a language the application has. Without configuration, these are the languages with a file in the language directory plus `lang.default`. To list them explicitly, set `lang.supported` in `odac.json`. The list is then a strict whitelist: other files are ignored, and the default language is always included.

```json
{
  "lang": {
    "default": "en",
    "supported": ["en", "tr", "de"]
  }
}
```

A visitor who asks for an unsupported language gets the default one. Key collection never creates a file for a language a client asked for. To add a language, create its file (`lang/fr.json` containing `{}` is enough) or add it to `lang.supported`.

### Missing Translations and Fallback

A key without a translation in the active language is served from its [parent language](#regional-languages) (`pt` for `pt-BR`), then from the default language, and if that has no translation either, as the key itself. An empty string in a language file means "not translated yet":

```json
// lang/tr.json
{
  "nav.home": "Ana Sayfa",
  "nav.about": ""
}
```

Here `nav.about` is served from `en.json` until it is translated.

### Setting the Language

The language is chosen in this order:

1. The code passed to `Odac.Lang.set()`, if a supported language serves it.
2. The most preferred `Accept-Language` entry a supported language serves (q values respected, e.g. `de-DE,de;q=0.9,tr;q=0.8` picks `tr` when there is no `de.json`). How a code finds its file (`tr-TR` → `tr.json`) is described in [Regional Languages](#regional-languages).
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

`Odac.Lang.set()` accepts [language codes](#regional-languages) in any case and with `-` or `_` (`pt_br`, `PT-BR`); anything else falls back as described above. `Odac.Lang.current()` returns the active code in canonical form (`pt-BR`), ready for `Intl` (`new Intl.DateTimeFormat(Odac.Lang.current())`). `Odac.Lang.dir()` returns its writing direction: `'rtl'` for Arabic, Hebrew, Persian, Urdu and a few others, or for a right-to-left script subtag (`pa-Arab`), `'ltr'` otherwise.

### Regional Languages

A language code is `language[-Script][-REGION]`, a subset of BCP 47:

| Code | Meaning |
|------|---------|
| `pt`, `fil` | A language (two or three letters) |
| `pt-BR`, `es-419` | The language as used in a region (two letters, or three digits for an area) |
| `zh-Hant`, `zh-Hans` | The language in a script (four letters) |
| `zh-Hant-TW` | Both |

File names use the canonical case: `pt-BR.json`, `zh-Hant.json`. A file named otherwise (`pt-br.json`, `pt_BR.json`) is not a language file and is ignored. Variants, extensions and private-use subtags are not supported; in `Accept-Language` they are dropped (`de-CH-1996` is read as `de-CH`).

A regional file only needs what differs from its language. Everything it leaves empty is served from the parent file, then from the default language:

```json
// lang/pt.json                // lang/pt-BR.json
{                              {
    "Bus": "Autocarro",            "Bus": "Ônibus",
    "Hello": "Olá"                 "Hello": ""
}                              }
```

A Brazilian visitor gets "Ônibus" and "Olá". Text served from the parent is not a missing translation: it is not logged, not highlighted, and `odac lang:check --strict` does not report it. Key collection still adds every key to every file (`""` in `pt-BR.json`), so you can see what could be overridden.

A requested code finds its file in this order, for each `Accept-Language` entry from the most preferred:

1. The exact code: `pt-BR` → `pt-BR.json`.
2. Its parents: `tr-TR` → `tr.json`, `zh-Hant-TW` → `zh-Hant.json`, then `zh.json`.
3. The script and region it implies: `zh-TW` → `zh-Hant.json`, `zh-CN` → `zh-Hans.json`, `en` → `en-US.json`, `pt` → `pt-BR.json`.
4. Any file for that language, alphabetically: `de` → `de-CH.json`.

A less preferred entry never wins over a match for a more preferred one: `pt, en` picks `pt-BR.json` when there is no `pt.json`. `Odac.Lang.set()` matches the same way, so `Odac.Lang.set('pt-PT')` serves `pt.json` when there is no `pt-PT.json`.

Browsers send region codes (`zh-TW`, `zh-CN`) rather than script codes, and step 3 maps them, so naming Chinese files by script (`zh-Hant.json`, `zh-Hans.json`) serves Taiwan, Hong Kong and mainland visitors correctly.

### The Page Language

ODAC writes the served language into every page, so you never maintain it by hand:

```html
<!-- skeleton/main.html -->
<html lang="en">

<!-- served to a Turkish visitor -->
<html lang="tr" dir="ltr" data-odac-skeleton="main" ...>

<!-- served to an Arabic visitor -->
<html lang="ar" dir="rtl" data-odac-skeleton="main" ...>
```

- `lang` and `dir` on `<html>` replace whatever the skeleton has. Screen readers, the browser's "Translate this page" offer, `hyphens: auto` and case mapping all read them: `text-transform: uppercase` turns `i` into `İ` only under `lang="tr"`.
- The response carries `Content-Language: tr`.
- AJAX navigation updates `<html lang dir>` when the language changes.

This happens when the application declares its languages: it has more than one language, or sets `lang.default` or `lang.supported` in `odac.json`. A single-language application that configures neither keeps the skeleton's `lang` as written, because the framework would otherwise have to guess `en`. If your site is in one language other than English, set `lang.default`:

```json
{
  "lang": {"default": "tr"}
}
```

### One URL, Several Languages

When the language comes from the `Accept-Language` header, the same URL returns different HTML to different visitors. ODAC then adds `Vary: Accept-Language` to the response, so no shared cache serves one visitor's language to another. The ODAC Proxy does not cache such responses, even with `Odac.cache()`.

A language chosen with `Odac.Lang.set()` does not depend on that header and gets no `Vary: Accept-Language`. That leads to the recommended setup for public, cacheable or search-indexed pages: put the language in the URL.

```javascript
// route/www.js
Odac.Route.page('/{lang}/about', 'About')

// controller/About.js
module.exports = function (Odac) {
  Odac.Lang.set(Odac.request('lang'))
  Odac.cache(3600) // one cache entry per URL, so per language
  Odac.View.skeleton('main').set('content', 'about')
}
```

Things to keep in mind when several languages share one URL:

- **Search engines**: crawlers mostly send no `Accept-Language` (Googlebot crawls mainly from the US), so only the default language gets indexed, and `hreflang` alternates need a separate URL per language. Keep shared URLs for pages behind a login (dashboards, account pages).
- **User choice**: `Accept-Language` alone does not let a visitor pick another language. Store the choice (user record, session) and pass it to `Odac.Lang.set()`. If you read it from a cookie, the page also differs per cookie: do not `Odac.cache()` it.
- **Mail and background jobs**: they have no visitor request; pass the user's stored language to `Odac.Lang.set()` instead of relying on the header.

### Using Translation Helper in Controllers

You can also use translations in your controllers:

```javascript
module.exports = async function(Odac) {
  const message = Odac.__('Welcome back, %s!', user.name)
  
  Odac.set('message', message)
  Odac.View.skeleton('main').set('content', 'dashboard')
}
```

`Odac.__()`, `Odac.__x()`, `Odac.Lang.get()` and `Odac.Lang.getx()` are synchronous and return a string: every language file is loaded into memory when the app starts, so a lookup never waits for the disk. Existing code that writes `await Odac.__(...)` keeps working.

### Managing Language Files

ODAC can read the translation keys straight from your code, so language files can be checked and cleaned up without visiting every page:

```bash
npx odac lang:sync           # add every key used in code to every language file
npx odac lang:check          # report what is out of sync; exit code 1 if anything is
npx odac lang:check --strict # also fail on missing translations (for CI)
npx odac lang:prune          # list keys no code uses (dry run)
npx odac lang:prune --write  # remove them from every language file
npx odac lang:prune --write --include-runtime  # also remove keys only seen at runtime (see below)
```

The scan covers views and skeletons (`.html`, compiled the same way as at runtime, so `<odac translate>Hello <odac var="name" /></odac>` is found as `Hello %s1`) and JavaScript/TypeScript files (`Odac.__()`, `Odac.__x()`, `Odac.Lang.get()`, `Odac.Lang.getx()`). `node_modules/`, `storage/`, `public/`, dot directories and `*.min.*` files are skipped. Keys ODAC itself translates are always kept.

`lang:prune` never runs automatically and removes nothing without `--write`, because removing a key deletes its translations in every language. Files that are not valid JSON stop `lang:prune` and are never modified.

#### Keys Built at Runtime

A key that is not a string literal cannot be found in the source:

```javascript
Odac.__(`status.${order.status}`)   // reported as a dynamic call
```

`lang:check` and `lang:prune` list such calls. List their keys in `lang.keep` so they are never reported as unused; an entry ending in `*` keeps every key with that prefix:

```json
{
  "lang": {
    "keep": ["status.*", "Some exact key"]
  }
}
```

As a safety net, ODAC also remembers which keys the app actually looked up while it ran in development (whenever key collection is on), with the day each was last used, in `storage/.cache/lang-runtime.json`. That file is git-ignored and specific to your machine. `lang:prune` does not remove a key found there, even with `--write`; it lists it separately:

```
1 key(s) not found in code but used while the app ran (kept):
    "status.shipped"  (last used 2026-11-10)
    Add them to "lang.keep", or pass --include-runtime to remove them too.
```

`npx odac lang:prune --write --include-runtime` removes those keys as well. `lang:check` still reports them as a failure, because CI has no such record. The record only knows the code paths you ran, so add these keys to `lang.keep`; that is what protects them everywhere.

Prefer literal keys where you can (e.g. a map from status to `Odac.__('Shipped')`), so the scan sees them.

### Translations in Browser Code

`__()` and `__x()` also work in `view/js/` (as globals, or as `Odac.__()` and `Odac.__x()`); only the keys that code uses are sent to the browser. See the frontend guide, *Translations in the Browser*.

### Best Practices

1. **Use descriptive keys**: Make translation keys meaningful; use `context` when the same text means different things
2. **Keep keys consistent**: Use the same key for the same text across your app
3. **Group with prefixes**: Files are sorted by key, so a shared prefix (`nav.`, `form.`) keeps related entries together
4. **Escape HTML carefully**: Only use `raw` with trusted content
5. **Check in CI**: Run `npx odac lang:check --strict` to catch missing and unused keys before release
6. **Use literal keys**: Computed keys cannot be detected by `lang:check` and `lang:prune`; list them in `lang.keep`

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
