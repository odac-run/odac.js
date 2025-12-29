# 🧩 Components

Components allow you to build reusable UI elements that can be used across your application. They promote code organization, reusability, and clean separation of concerns.

## Creating Components

Components are standard HTML files located in the `view/components/` directory.

### Directory Structure

```text
view/
  components/
    navbar.html      --> <odac:component name="navbar" />
    card.html        --> <odac:component name="card" />
    ui/
      button.html    --> <odac:component name="ui/button" />
```

### Basic Example

**File:** `view/components/alert.html`

```html
<div class="alert alert-{{ type }}">
    <strong>{{ title }}</strong>: {{ message }}
</div>
```

## Using Components

To use a component in your views, use the `<odac:component>` tag.

### Passing Props `(Attributes)`

You can pass data to your component via attributes. These attributes become available as variables inside the component.

```html
<odac:component name="alert" type="danger" title="Error" message="Something went wrong!" />
```

### Passing Variables

You can also pass variables from your controller or parent view using interpolation syntax `{}`.

```html
<odac:component name="user-card" user="{currentUser}" />
```

## Slots `(Inner Content)`

Components can accept inner content, known as **Slots**. This allows you to create wrapper components like modals, cards, or layouts.

**File:** `view/components/modal.html`

```html
<div class="modal">
    <div class="modal-header">{{ title }}</div>
    <div class="modal-body">
        {!! slot !!}
    </div>
</div>
```

**Usage:**

```html
<odac:component name="modal" title="Confirm Action">
    <p>Are you sure you want to delete this item?</p>
    <odac:component name="ui/button" type="danger" label="Yes, Delete" />
</odac:component>
```

In the example above, the HTML content inside `<odac:component>` is injected into the `{!! slot !!}` variable within the component.

::: info
**Note:** The content inside the slot is rendered in the **parent's scope**. This means variables used inside the slot refer to the parent's data, not the component's internal data.
:::

## Component Recursion and Nesting

Components can be nested within each other or even used recursively. All standard Odac tags (like `if`, `for`, `fetch`) work seamlessly inside components.

```html
<odac:component name="card">
    <odac:if condition="user.isLoggedIn">
        <odac:component name="user-profile" user="{user}" />
    </odac:if>
</odac:component>
```

## Best Practices

1.  **Naming:** Use kebab-case for component filenames (`user-card.html`) and match usage (`name="user-card"`).
2.  **Organization:** Group related components into subdirectories (e.g., `view/components/form/input.html`).
3.  **Encapsulation:** Keep your components focused on a single responsibility.
4.  **Slots:** Use slots for flexible content injection rather than passing large HTML strings as props.
