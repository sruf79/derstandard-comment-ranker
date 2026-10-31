import { describe, it, expect, vi } from 'vitest';
import { createEnv } from '../helpers/env.js';
import { track } from '../helpers/setup.js';

const GRAPHQL_URL = 'https://capi.ds.at/forum-serve-graphql';

const GRAPHQL_BODY = JSON.stringify({
  data: {
    getForumRootPostingsV2: {
      edges: [
        { node: { id: 'ENC1', legacy: { postingId: 1151194732 }, replies: [
          { id: 'ENC1R', legacy: { postingId: 1151194999 } }
        ] } },
        { node: { id: 'ENC2', legacy: { postingId: 0 } } },
        { node: { id: 'NOLEGACY' } },
        { node: { id: 'NULLID', legacy: { postingId: null } } }
      ]
    }
  }
});

// Like a real Response, the body can be read only once; clone() gives a fresh copy.
function response(body) {
  let used = false;
  return {
    ok: true,
    status: 200,
    clone: () => response(body),
    text: async () => {
      if (used) throw new TypeError('body stream already read');
      used = true;
      return body;
    }
  };
}

async function setup({ fetchImpl } = {}) {
  const env = track(await createEnv());
  const origFetch = vi.fn(fetchImpl || (async () => response(GRAPHQL_BODY)));
  env.window.fetch = origFetch;
  const events = [];
  env.window.addEventListener('dst-voter-idmap', (e) => events.push(JSON.parse(e.detail)));
  const h = env.load('forum-hook.js');
  return { env, h, origFetch, events };
}

describe('collectPairs', () => {
  it('collects every {encodedId: numericId} pair recursively', async () => {
    const { h } = await setup();
    const out = {};
    h.collectPairs(JSON.parse(GRAPHQL_BODY), out);
    expect(out).toEqual({ ENC1: '1151194732', ENC1R: '1151194999', ENC2: '0' });
  });

  it.each([null, undefined, 42, 'str', []])('ignores %j', async (input) => {
    const { h } = await setup();
    const out = {};
    h.collectPairs(input, out);
    expect(out).toEqual({});
  });
});

describe('relay', () => {
  it('dispatches the pairs as a JSON string event', async () => {
    const { h, events } = await setup();
    h.relay(GRAPHQL_BODY);
    expect(events).toEqual([{ ENC1: '1151194732', ENC1R: '1151194999', ENC2: '0' }]);
  });

  it.each(['', 'not json', '{"data":{}}', '[]'])('stays silent for %j', async (body) => {
    const { h, events } = await setup();
    h.relay(body);
    expect(events).toEqual([]);
  });
});

describe('isForumGraphql', () => {
  it('matches only forum GraphQL endpoints', async () => {
    const { h } = await setup();
    expect(h.isForumGraphql(GRAPHQL_URL)).toBe(true);
    expect(h.isForumGraphql('https://capi.ds.at/other-graphql')).toBe(false);
    expect(h.isForumGraphql(undefined)).toBe(false);
  });
});

describe('fetch wrapper', () => {
  it('relays id pairs from forum GraphQL responses (string, URL and Request input)', async () => {
    const { env, events } = await setup();
    await env.window.fetch(GRAPHQL_URL);
    await env.window.fetch(new env.window.URL(GRAPHQL_URL));
    await env.window.fetch({ url: GRAPHQL_URL }); // Request-like
    await env.flush();
    expect(events).toHaveLength(3);
  });

  it('returns the original response untouched and keeps its body readable', async () => {
    const { env, origFetch } = await setup();
    const resp = await env.window.fetch(GRAPHQL_URL, { method: 'POST', body: '{}' });
    expect(origFetch).toHaveBeenCalledWith(GRAPHQL_URL, { method: 'POST', body: '{}' });
    await env.flush(); // let the hook read its clone first
    expect(await resp.text()).toBe(GRAPHQL_BODY);
  });

  it('does not read bodies of unrelated requests', async () => {
    const clone = vi.fn();
    const { env, events } = await setup({ fetchImpl: async () => ({ clone }) });
    await env.window.fetch('https://www.derstandard.at/api/other');
    await env.flush();
    expect(clone).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('propagates network errors unchanged to the page', async () => {
    const err = new TypeError('Failed to fetch');
    const { env } = await setup({ fetchImpl: async () => { throw err; } });
    await expect(env.window.fetch(GRAPHQL_URL)).rejects.toBe(err);
  });

  it('survives responses whose body cannot be read', async () => {
    const { env, events } = await setup({
      fetchImpl: async () => ({ clone: () => { throw new Error('already used'); } })
    });
    await expect(env.window.fetch(GRAPHQL_URL)).resolves.toBeTruthy();
    await env.flush();
    expect(events).toEqual([]);
  });
});

describe('XMLHttpRequest wrapper', () => {
  it('relays GraphQL responses and still calls the native open/send', async () => {
    const env = track(await createEnv());
    const opened = [];
    const sent = [];
    class FakeXHR extends env.window.EventTarget {
      open(method, url) { opened.push([method, url]); }
      send(body) {
        sent.push(body);
        this.responseText = GRAPHQL_BODY;
        env.window.setTimeout(() => this.dispatchEvent(new env.window.Event('load')), 0);
      }
    }
    env.window.XMLHttpRequest = FakeXHR;
    const events = [];
    env.window.addEventListener('dst-voter-idmap', (e) => events.push(JSON.parse(e.detail)));
    env.load('forum-hook.js');

    const xhr = new env.window.XMLHttpRequest();
    xhr.open('POST', GRAPHQL_URL);
    xhr.send('{"q":1}');
    const other = new env.window.XMLHttpRequest();
    other.open('GET', '/foo');
    other.send();
    await env.tick(1);

    expect(opened).toEqual([['POST', GRAPHQL_URL], ['GET', '/foo']]);
    expect(sent).toEqual(['{"q":1}', undefined]);
    expect(events).toHaveLength(1);
  });
});

describe('load-state bridge (dst-request-load-state)', () => {
  function nativeForum(env, overrides = {}) {
    const forum = env.document.createElement('dst-forum');
    Object.assign(forum, {
      forumModel: new Map([['a', {}], ['b', {}]]),
      stickyPostingsModel: new Map([['a', {}], ['s', {}]]),
      threadsByForumQuery: { data: { getForumRootPostingsV2: { pageInfo: { nextCursor: 'CUR' } } } },
      _totalPostingCount: '120',
      hasMorePostings: () => true,
      isLoading: false,
      activeFilter: 0,
      sortField: 'ByTime',
      sortDirection: 'descending',
      isPermalink: false,
      isFolloweeTabChange: false
    }, overrides);
    env.document.body.appendChild(forum);
    return forum;
  }

  function request(env, forum) {
    forum.dispatchEvent(new env.window.Event('dst-request-load-state', { bubbles: true }));
    const raw = forum.getAttribute('data-dst-load-state');
    return raw && JSON.parse(raw);
  }

  it('exposes counts and pagination flags of the native model', async () => {
    const { env } = await setup();
    const forum = nativeForum(env);
    expect(request(env, forum)).toEqual({
      loaded: 3, total: 120, more: true, loading: false, all: true, cursor: 'CUR'
    });
  });

  it.each([
    [{ activeFilter: 1 }],
    [{ sortField: 'ByRating' }],
    [{ sortDirection: 'ascending' }],
    [{ isPermalink: true }]
  ])('reports all=false for a restricted view %j', async (override) => {
    const { env } = await setup();
    expect(request(env, nativeForum(env, override)).all).toBe(false);
  });

  it('never claims a state without native query data', async () => {
    const { env } = await setup();
    expect(request(env, nativeForum(env, { threadsByForumQuery: undefined }))).toBeNull();
    expect(request(env, nativeForum(env, { hasMorePostings: undefined }))).toBeNull();
  });

  it('ignores events from other elements', async () => {
    const { env } = await setup();
    const div = env.document.createElement('div');
    Object.assign(div, { hasMorePostings: () => true, forumModel: new Map() });
    env.document.body.appendChild(div);
    expect(request(env, div)).toBeNull();
  });
});
