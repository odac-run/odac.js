/**
 * ODAC Template - Client-Side Application
 *
 * This file is automatically compiled by ODAC's JS/TS pipeline.
 * Write your frontend logic here — TypeScript (.ts) and plain JavaScript (.js) both work.
 *
 * - Place files in view/js/ to create entry points
 * - Files starting with _ are ignored (use them as shared imports)
 * - Output goes to public/assets/js/{name}.min.js
 *
 * Features demonstrated:
 * - AJAX page loading with Odac.loader() for smooth navigation
 * - History API integration
 * - Event delegation
 */

Odac.action({
  /**
   * Initialize application on page load
   * This runs once when the page first loads
   */
  load: function () {
    // Set initial active navigation state
    Odac.fn.updateActiveNav(window.location.pathname)
  },

  /**
   * Page-specific initialization
   * These functions run when specific pages are loaded
   */
  page: {
    /**
     * Home page initialization
     */
    index: function () {
      console.log('Home page loaded')
    },

    /**
     * About page initialization
     */
    about: function () {
      console.log('About page loaded')
    }
  },

  // Add your custom event handlers here
  // Example:
  // click: {
  //   '#my-button': function() {
  //     console.log('Button clicked')
  //   }
  // }

  /**
   * Custom functions
   * These become available as Odac.fn.functionName()
   */
  function: {
    /**
     * Update active navigation state
     * Highlights the current page in the navigation menu
     */
    updateActiveNav: function (url) {
      // Remove active class from all navigation links
      const navLinks = document.querySelectorAll('nav a')
      navLinks.forEach(function (link) {
        link.classList.remove('active')
      })

      // Add active class to current page link
      const currentLinks = document.querySelectorAll(`nav a[href="${url}"]`)
      if (currentLinks.length > 0) {
        currentLinks.forEach(function (link) {
          link.classList.add('active')
        })
      } else if (url === '/' || url === '') {
        // Handle home page
        const homeLinks = document.querySelectorAll('nav a[href="/"]')
        homeLinks.forEach(function (link) {
          link.classList.add('active')
        })
      }
    }
  }
})
