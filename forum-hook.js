/*
 * forum-hook.js  (v1.9.18)
 * ---------------------------------------------------------------------------
 * Runs in the MAIN world (page context) at document_start.
 *
 * Purpose: The new derStandard forum (Lit web components, GraphQL backend at
 * capi.ds.at/forum-serve-graphql) only exposes ENCODED posting IDs in the DOM
 * (e.g. "3FCp708KUMlBw8BaaUJilPAtTWq"). The public ratinglog endpoint that still
 * returns the voter list (apps.derstandard.at/forum/ratinglog) needs the LEGACY
 * NUMERIC posting ID (e.g. 1151194732).
 *
 * Every GraphQL posting node contains BOTH ids:
 *     node.id                -> encoded id   (matches the DOM postingid attr)
 *     node.legacy.postingId  -> numeric id   (works with the ratinglog endpoint)
 *
 * This hook passively wraps window.fetch / XMLHttpRequest, parses every
 * forum-serve-graphql response, extracts all { encodedId: numericId } pairs and
 * relays them to the isolated content script via a CustomEvent. The content
 * script builds a lookup map so it can translate a clicked rating element's
 * encoded id into the numeric id required by the ratinglog endpoint.
 *
 * It captures nothing else and never modifies any request or response.
 */
(function () {
  'use strict';

  var EVENT_NAME = 'dst-voter-idmap';

  // Read-only bridge for the isolated loader. Collapsed replies are in the
  // native model even when they have no dst-posting element in the DOM.
  document.addEventListener('dst-request-load-state', function (event) {
    var forum = event.target;
    if (!forum || forum.tagName !== 'DST-FORUM' ||
        typeof forum.hasMorePostings !== 'function' || !forum.forumModel) return;
    try {
      var ids = new Set();
      [forum.forumModel, forum.stickyPostingsModel].forEach(function (model) {
        if (model) model.forEach(function (_, id) { ids.add(id); });
      });
      var page = forum.threadsByForumQuery?.data?.getForumRootPostingsV2?.pageInfo;
      if (!page) return; // Initialization/query failure is not an empty forum.
      var state = {
        loaded: ids.size,
        total: Number(forum._totalPostingCount) || 0,
        more: forum.hasMorePostings(),
        loading: !!forum.isLoading,
        all: forum.activeFilter === 0 && forum.sortField === 'ByTime' &&
          forum.sortDirection === 'descending' && !forum.isPermalink && !forum.isFolloweeTabChange,
        cursor: String(page.nextCursor || '')
      };
      forum.setAttribute('data-dst-load-state', JSON.stringify(state));
    } catch (e) { /* Unknown native version: do not claim completion. */ }
  });

  // Recursively walk a parsed GraphQL object and collect {encodedId: numericId}
  // pairs from any node that carries both an `id` and a `legacy.postingId`.
  function collectPairs(obj, out) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) collectPairs(obj[i], out);
      return;
    }
    try {
      if (obj.id && obj.legacy && obj.legacy.postingId != null) {
        out[String(obj.id)] = String(obj.legacy.postingId);
      }
    } catch (e) { /* ignore */ }
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        var v = obj[k];
        if (v && typeof v === 'object') collectPairs(v, out);
      }
    }
  }

  function relay(text) {
    var json;
    try { json = JSON.parse(text); } catch (e) { return; }
    var pairs = {};
    collectPairs(json, pairs);
    if (Object.keys(pairs).length === 0) return;
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: JSON.stringify(pairs) }));
    } catch (e) { /* ignore */ }
  }

  function isForumGraphql(url) {
    return typeof url === 'string' && url.indexOf('forum-serve-graphql') !== -1;
  }

  // ── Hook window.fetch ──────────────────────────────────────────────────
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      var url = '';
      // v2.4.10: also handles URL objects (previously only strings/Request).
      try { url = args[0] ? String(args[0].url || args[0]) : ''; } catch (e) {}
      var p = origFetch.apply(this, args);
      if (isForumGraphql(url)) {
        try {
          p.then(function (resp) {
            try { resp.clone().text().then(relay).catch(function () {}); } catch (e) {}
          }).catch(function () {});
        } catch (e) {}
      }
      return p;
    };
  }

  // ── Hook XMLHttpRequest (fallback, in case the app ever uses XHR) ───────
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__dstUrl = url == null ? '' : String(url); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      var self = this;
      if (isForumGraphql(self.__dstUrl)) {
        self.addEventListener('load', function () {
          try { relay(self.responseText); } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();
