---
name: backend-odac-var-skill
description: Comprehensive API reference and practical patterns for the Odac.Var utility class. Includes every single method available in src/Var.js.
metadata:
  tags: backend, utilities, strings, hashing, encryption, validation, mapping
---

# Backend Odac.Var API Reference

`Odac.Var` is a high-performance utility class for string manipulation, security, and validation.

## Core Principles
- **Direct Output**: Manipulation methods return raw values (string/object). Chaining is NOT supported.
- **Type Safety**: Methods handle various input types (strings, arrays, objects) gracefully.
- **Enterprise Security**: Uses scrypt for hashing and AES-256-CBC for encryption.

---

## 🛠 Full Method List & API Reference

### 1. `.clear(...args)`
Removes specified strings from the value using global regex.
```javascript
Odac.Var('a-b-c').clear('-'); // 'abc'
Odac.Var('hello123world').clear('1', '2', '3'); // 'helloworld'
```

### 2. `.contains(...args)`
Checks if the string contains **all** of the specified values (AND logic).
```javascript
Odac.Var('hello world').contains('hello', 'world'); // true
```

### 3. `.containsAny(...args)`
Checks if the string contains **any** of the specified values (OR logic).
```javascript
Odac.Var('hello world').containsAny('foo', 'world'); // true
```

### 4. `.date(format)`
Formats a date string/timestamp. Default: `Y-m-d H:i:s`.
- Tokens: `Y` (2024), `y` (24), `m` (01-12), `d` (01-31), `H` (00-23), `i` (00-59), `s` (00-59).
```javascript
Odac.Var('2024-04-10').date('d/m/Y'); // '10/04/2024'
```

### 5. `.encrypt(key?)`
Encrypts the value using AES-256-CBC. Uses `Odac.Config.encrypt.key` by default. Returns Base64.
```javascript
const secret = Odac.Var('data').encrypt();
```

### 6. `.decrypt(key?)`
Decrypts an AES-256-CBC Base64 string.
```javascript
const data = Odac.Var(secret).decrypt();
```

### 7. `.hash()`
Generates a secure **scrypt** hash. Returns string prefixed with `$scrypt$`.
```javascript
const hash = Odac.Var('password').hash();
```

### 8. `.hashCheck(check)`
Verifies a plain text string against an existing scrypt hash. Uses `timingSafeEqual`.
```javascript
Odac.Var(hash).hashCheck('password'); // true
```

### 9. `.html()`
Escapes HTML special characters (`&`, `<`, `>`, `"`, `'`).
```javascript
Odac.Var('<div>').html(); // '&lt;div&gt;'
```

### 10. `.is(...args)`
Validates string against **all** specified rules (AND logic).
```javascript
Odac.Var('test@test.com').is('email'); // true
```

### 11. `.isAny(...args)`
Validates string against **any** specified rule (OR logic).
```javascript
Odac.Var('user123').isAny('email', 'username'); // true
```

### 12. `.isBegin(...args)`
Checks if string starts with any of the specified values.
```javascript
Odac.Var('https://odac.run').isBegin('http', 'https'); // true
```

### 13. `.isEnd(...args)`
Checks if string ends with any of the specified values.
```javascript
Odac.Var('image.png').isEnd('.png', '.jpg'); // true
```

### 14. `.md5()`
Generates an MD5 hash of the value.
```javascript
Odac.Var('hello').md5(); // '5d41402...'
```

### 15. `.replace(...args)`
Replaces values in the string. If the Var value is an object/array, it applies replacement recursively.
```javascript
// String replacement
Odac.Var('Hello {{n}}').replace('{{n}}', 'Emre'); 

// Bulk replacement
Odac.Var('{{a}} {{b}}').replace({ '{{a}}': '1', '{{b}}': '2' });

// Recursive object replacement
Odac.Var({ key: '{{v}}' }).replace('{{v}}', 'data'); // { key: 'data' }
```

### 16. `.save(path)`
Saves the value to a file. **Auto-creates directories** recursively if they don't exist.
```javascript
Odac.Var('content').save('./storage/logs/app.log');
```

### 17. `.slug(separator = '-')`
Generates a URL-friendly slug. Replaces non-alphanumeric chars with separator.
```javascript
Odac.Var('Hello World!').slug(); // 'hello-world'
```

### 18. `.format(format)`
Formats a string based on a pattern.
- `?`: Placeholder for a single character from the input.
- `*`: Placeholder for the remaining part of the input.
```javascript
Odac.Var('12345').format('??-???'); // '12-345'
Odac.Var('TR12345').format('?? *'); // 'TR 12345'
```

---

## 🔍 Validation Rule Catalog (for `.is()` and `.isAny()`)
- `alpha`, `alphaspace`: `A-Z, a-z` (+ spaces).
- `alphanumeric`, `alphanumericspace`: `A-Z, a-z, 0-9` (+ spaces).
- `username`: `A-Z, a-z, 0-9` (Strictly alphanumeric).
- `numeric`, `float`: Numbers and decimals.
- `email`, `domain`, `url`: Standard web identifiers.
- `ip`, `host`, `mac`: Networking addresses.
- `json`: Check if value is valid JSON.
- `date`: Check if value is a valid date string.
- `hash`: Check if value follows `$scrypt$` hash format.
- `xss`: Check if value is free of HTML tags.
- `emoji`: Detect presence of emojis.
- `md5`: Check for 32-char hex string.
