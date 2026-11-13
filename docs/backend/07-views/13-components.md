## 🧩 Components

Components are reusable pieces of markup, such as buttons, cards, modals or menus, that you use like HTML tags inside any view and inside other components. You customize each use with attributes and fill it with content through slots.

### Creating a Component

Put an HTML file in `view/components/`. Its file name is the tag name, prefixed with `c:`:

```
view/components/button.html      →  <c:button>
view/components/card.html        →  <c:card>
view/components/ui/modal.html    →  <c:ui.modal>   (subdirectories use dots)
```

```html
<!-- view/components/button.html -->
<odac:props variant="'primary'" />

<button {!! attrs.class('btn btn-' + variant) !!}>
  <odac:slot />
</button>
```

```html
<!-- any view -->
<c:button>Save</c:button>
<c:button variant="danger" id="delete" type="submit">Delete</c:button>
```

Output:

```html
<button class="btn btn-primary">Save</button>
<button class="btn btn-danger" id="delete" type="submit">Delete</button>
```

The `c:` prefix cannot clash with real HTML or Web Components: custom element names cannot contain a colon.

### Props

`<odac:props>` declares what a component accepts and what it uses when the caller leaves something out. Write it once, at the top of the component. It works like a function's parameter list:

```html
<odac:props title="'Untitled'" size="'md'" count="0" :user />
```

- Each value is a **JavaScript expression** used as the default: `'Untitled'` is a string, `0` a number.
- A prop **without a value** (`:user` or `user`) is **required**. Using the component without it answers 500 and logs which view forgot it.
- Declared props are variables inside the component: `{{ title }}`, `<odac:if condition="user.isAdmin">`.
- Every value the caller passed is also on `props`, with kebab-case names in camelCase: `max-items="5"` → `props.maxItems`.

### Passing Values

| Attribute | Value the component receives |
|-----------|------------------------------|
| `title="Dashboard"` | The string `"Dashboard"` |
| `title="Order #{{ order.id }}"` | A string with the expression inserted |
| `:user="currentUser"` | The result of a JavaScript expression (any type) |
| `:count="items.length"` | A number |
| `disabled` | `true` |
| `max-items="5"` | Matches the prop `maxItems` |

```html
<c:card title="Order #{{ order.id }}" :user="currentUser" :items="order.items" compact />
```

Values are escaped where they are printed (`{{ title }}`), never when they are passed, so nothing is escaped twice.

### Pass-Through Attributes

Attributes that are not declared props, such as `class`, `id`, `data-*` and `aria-*`, are collected in `attrs`. Print them on the component's root element:

```html
<!-- view/components/card.html -->
<odac:props title="'Card'" />
<div {!! attrs.class('card') !!}>
  <h3>{{ title }}</h3>
  <odac:slot />
</div>
```

```html
<c:card title="Profile" class="mt-4" data-id="{{ user.id }}" :hidden="!user.visible">...</c:card>
<!-- <div class="card mt-4" data-id="42">...</div> -->
```

- Values are HTML-escaped. `true` prints a bare attribute (`hidden`); `false`, `null` and `undefined` leave the attribute out.
- `attrs.class('card')` merges the component's classes with the caller's `class`. Do not write `class="card"` next to `{!! attrs !!}`: the browser keeps only the first `class` attribute.
- `attrs.except('id')` and `attrs.only('id', 'title')` print a subset; `attrs.has('id')` and `attrs.get('id')` read single values.
- To bind a frontend framework attribute on a component (Alpine's `:class`), use its long form (`x-bind:class`): a leading `:` on a component tag is an ODAC expression.

### Slots

The content between the opening and closing tag is the **default slot**. `<odac:slot />` prints it; its children are the fallback when the caller passed nothing.

**Named slots** fill other places. Inside the component tag, `<odac:slot name="...">` provides content; inside the component, the same tag prints it:

```html
<!-- view/components/modal.html -->
<odac:props title />
<div class="modal">
  <header>{{ title }}</header>
  <div class="body"><odac:slot>Nothing here.</odac:slot></div>
  <odac:if condition="slots.footer">
    <footer><odac:slot name="footer" /></footer>
  </odac:if>
</div>
```

```html
<c:modal title="Delete user">
  <p>This cannot be undone.</p>
  <odac:slot name="footer">
    <c:button variant="danger">Delete</c:button>
  </odac:slot>
</c:modal>
```

- `slots.footer` tells whether the caller provided a slot, so wrapping markup can be skipped.
- Slot content renders in the **caller's** scope: loop variables and the page's variables work inside it.
- A slot can be provided conditionally: `<odac:if condition="canEdit"><odac:slot name="actions">...</odac:slot></odac:if>`.
- A wrapping component forwards its own slots by printing them inside another component: `<c:card><odac:slot /></c:card>`.

### Components Inside Components

Components can use other components, and themselves. A component that renders itself is the simplest way to draw trees:

```html
<!-- view/components/tree.html -->
<odac:props :node />
<li>
  {{ node.name }}
  <odac:if condition="node.children">
    <ul>
      <odac:for in="node.children" value="child">
        <c:tree :node="child" />
      </odac:for>
    </ul>
  </odac:if>
</li>
```

Nesting stops at 50 levels with a 500 error, so a component that renders itself without an end condition cannot hang the server.

### Scope

A component sees **only its props**, not the variables of the page that uses it. It renders the same wherever it is used. `Odac` (auth, request, config), `get()` and the translation helpers (`__()`) are available in every component.

```html
<!-- Does not work: the page's `user` is not visible here -->
<p>{{ user.name }}</p>

<!-- Pass it explicitly -->
<c:profile :user="user" />
```

### Long Form

`<odac:component name="...">` is the same as `<c:...>`:

```html
<odac:component name="ui.modal" title="Settings">...</odac:component>
```

### Dynamic Components

`:is` picks the component when the page renders, for dashboards and block-based content:

```html
<odac:for in="widgets" value="widget">
  <odac:component :is="'widgets.' + widget.type" :data="widget" />
</odac:for>
```

The name is checked like a written one: it must stay inside `view/components/` (`../` and slashes are rejected with a 500). Never build it from unchecked user input. Map input to the names you allow instead.

### Rendering Once

A component used twenty times on a page should not print its `<style>` twenty times. Add `once` to a `<style>` or `<script>` element, or wrap any markup in `<odac:once>`:

```html
<!-- view/components/tooltip.html -->
<style once>.tooltip { position: absolute }</style>
<script once>document.addEventListener('mouseover', showTooltip)</script>
<odac:once><div id="tooltip-root"></div></odac:once>

<span class="tooltip" data-text="{{ props.text }}"><odac:slot /></span>
```

A `once` block renders the first time it is reached in a response; later uses of the same template skip it. The next request renders it again.

The content of plain `<script>` and `<style>` elements is left to the browser: component tags written inside them (for example in a JavaScript string) are not rendered.

### Push and Stack

A component in the page body often needs something in `<head>` (a stylesheet) or before `</body>` (a script). `<odac:push to="name">` sends content to the place marked `<odac:stack name="name" />`, usually in the skeleton:

```html
<!-- skeleton/main.html -->
<head>
  <title>My App</title>
  <odac:stack name="head" />
</head>
<body>
  <main>{{ CONTENT }}</main>
  <odac:stack name="scripts" />
</body>
```

```html
<!-- view/components/chart.html -->
<odac:props :points />
<odac:push to="head"><link rel="stylesheet" href="/css/chart.css"></odac:push>
<odac:push to="scripts"><script src="/js/chart.js"></script></odac:push>

<canvas class="chart" data-points="{{ JSON.stringify(points) }}"></canvas>
```

- Identical pushes are printed once, so a component can push its assets every time it renders.
- Pushed content renders in the scope where it is pushed (`{{ }}` works). It is printed where the stack is, even when the stack comes earlier in the page.
- A stack can be in the skeleton or in any part. Only the first `<odac:stack>` of a name is filled.
- **AJAX navigation:** the pushes of the next page are sent with the response. The browser adds the ones the page does not have yet, before the new content is shown (stylesheets apply without a flash). Pushed scripts run after the new content is in place, once per page load.
- Stack markers are rendered as empty `<template data-odac-stack>` elements, which the browser ignores. They are where navigation inserts new items.

### Components in Mail

Mail templates use components from `view/mail/components/`. They are separate from the page components because email needs table layouts and inline styles:

```html
<!-- view/mail/components/button.html -->
<odac:props :href label="'Open'" />
<a href="{{ href }}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:6px">{{ label }}</a>
```

```html
<!-- view/mail/welcome.html -->
<c:button :href="url" label="Confirm your email" />
```

Props, slots, `once` and push work the same. A `<odac:stack name="styles" />` in the mail's `<head>` collects the `<style>` blocks its components push.

### Rendering From a Controller

`Odac.View.component()` renders a component to an HTML string. Use it for AJAX responses and WebSocket pushes that update part of a page with the same markup the page uses:

```javascript
module.exports = async function (Odac) {
  const item = await Odac.DB.items.where('id', Odac.Request.get('id')).first()
  return Odac.View.component('cart.item', {item, class: 'highlight'})
}
```

The second argument holds props and pass-through attributes, as on the tag. Names are matched like attributes (`'max-items'` → `maxItems`), and attribute names that are not valid HTML are dropped.

### Errors

Every component error answers 500 and logs the file, the line and the views that used it:

```
TypeError: Cannot read properties of undefined (reading 'name')
  in line 4
  of "./view/components/card.html"
  used in "./view/components/list.html"
  used in "./view/content/home.html"
```

This covers a missing component file, a missing required prop, an error inside the component, and malformed markup such as a `</c:card>` that closes a `<c:list>`. A view never renders with an empty gap where a component failed.

### Performance

Each component compiles once to its own cached module. Rendering an instance is a function call (a few microseconds), with no file access in production. In debug mode a changed component is picked up on the next request without recompiling the views that use it. As with views, production caches components per process, so deploy (restart) to pick up changed files.

Components are rendered in views, their parts and mail templates. Skeleton files are static layouts: they hold `<odac:stack>` markers but do not render components.
