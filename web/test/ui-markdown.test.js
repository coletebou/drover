// Chat Markdown (ui/markdown.js): block structure and inline tokens. Rendering builds DOM nodes from these, so
// what is tested here is everything that decides what a reply looks like, and that no unsafe link survives.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, trimUrl, safeHref, splitRow, mdText } from '../ui/markdown.js';

const types = (src) => parseBlocks(src).map((b) => b.type);

describe('blocks', () => {
  test('paragraphs keep their line breaks; blank lines split them', () => {
    assert.deepEqual(parseBlocks('one\ntwo\n\nthree'), [{ type: 'para', text: 'one\ntwo' }, { type: 'para', text: 'three' }]);
    assert.deepEqual(parseBlocks('   \n\n'), []);
  });
  test('headings, rules and quotes', () => {
    assert.deepEqual(parseBlocks('## Plan ##'), [{ type: 'heading', level: 2, text: 'Plan' }]);
    assert.deepEqual(types('#hashtag is text'), ['para']);
    assert.deepEqual(types('above\n---\nbelow'), ['para', 'hr', 'para'], 'a rule under a line is a rule in chat, not a heading');
    const [q] = parseBlocks('> quoted\n> **still**\nlazy line');
    assert.equal(q.type, 'quote');
    assert.deepEqual(q.blocks, [{ type: 'para', text: 'quoted\n**still**\nlazy line' }]);
  });
  test('fenced code keeps its text exactly; an unclosed fence runs to the end (a reply mid-stream)', () => {
    assert.deepEqual(parseBlocks('```js\nconst a = 1;\n\n  indented\n```\nafter'), [{ type: 'code', lang: 'js', text: 'const a = 1;\n\n  indented' }, { type: 'para', text: 'after' }]);
    assert.deepEqual(parseBlocks('~~~\nx\n```\ny'), [{ type: 'code', lang: null, text: 'x\n```\ny' }], 'only the same fence closes');
    assert.deepEqual(parseBlocks('text\n```\npartial'), [{ type: 'para', text: 'text' }, { type: 'code', lang: null, text: 'partial' }]);
  });
  test('lists: bullets and numbers, nesting by indentation, task items, a list right after a line of text', () => {
    const [p, l] = parseBlocks('Steps:\n- one\n- two\n  - two a\n  - two b\n- three');
    assert.equal(p.type, 'para');
    assert.equal(l.type, 'list'); assert.equal(l.ordered, false); assert.equal(l.items.length, 3);
    assert.deepEqual(l.items[1].blocks.map((b) => b.type), ['para', 'list']);
    assert.equal(l.items[1].blocks[1].items.length, 2);
    const [o] = parseBlocks('3. three\n4. four');
    assert.deepEqual([o.ordered, o.start, o.items.length], [true, 3, 2]);
    const [t] = parseBlocks('- [ ] write\n- [x] test');
    assert.deepEqual(t.items.map((i) => i.task), [false, true]);
    assert.deepEqual(types('- a\n\n1. b'), ['list', 'list'], 'a different marker starts another list');
    const [n] = parseBlocks('1. Run it:\n   ```sh\n   npm test\n   ```\n2. Read it');
    assert.deepEqual(n.items[0].blocks, [{ type: 'para', text: 'Run it:' }, { type: 'code', lang: 'sh', text: 'npm test' }]);
    assert.equal(parseBlocks('- a\n- b')[0].loose, false);
    assert.equal(parseBlocks('- a\n\n- b')[0].loose, true);
    assert.deepEqual(types('-not a list\n*nor this*'), ['para']);
  });
  test('tables need a separator row; cells split on unescaped pipes; alignment comes from the colons', () => {
    const [t] = parseBlocks('| host | state |\n|:--|--:|\n| a | up |\n| b \\| c | down |');
    assert.deepEqual([t.type, t.head, t.align, t.rows], ['table', ['host', 'state'], ['left', 'right'], [['a', 'up'], ['b | c', 'down']]]);
    assert.deepEqual(types('a | b\nnot a separator'), ['para']);
    assert.deepEqual(splitRow('|x||y|'), ['x', '', 'y']);
  });
});

describe('inline', () => {
  const kinds = (s) => parseInline(s).map((t) => t.t);
  test('code, strong, em, del, escapes; snake_case stays text', () => {
    assert.deepEqual(parseInline('a **b** *c* `d` ~~e~~'), [
      { t: 'text', v: 'a ' }, { t: 'strong', children: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' ' }, { t: 'em', children: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' }, { t: 'code', v: 'd' }, { t: 'text', v: ' ' }, { t: 'del', children: [{ t: 'text', v: 'e' }] }]);
    assert.deepEqual(parseInline('my_var_name and __init__'), [{ t: 'text', v: 'my_var_name and ' }, { t: 'strong', children: [{ t: 'text', v: 'init' }] }]);
    assert.deepEqual(parseInline('\\*not em\\*'), [{ t: 'text', v: '*not em*' }]);
    assert.deepEqual(parseInline('`a **b**`'), [{ t: 'code', v: 'a **b**' }], 'nothing inside code is parsed');
    assert.deepEqual(parseInline('`` x ` y ``'), [{ t: 'code', v: 'x ` y' }]);
    assert.deepEqual(kinds('**bold with `code` inside**'), ['strong']);
    assert.deepEqual(parseInline('2 * 3 * 4'), [{ t: 'text', v: '2 * 3 * 4' }], 'a lone star between spaces is arithmetic');
  });
  test('links: markdown, autolinks and bare URLs, trailing punctuation left out', () => {
    assert.deepEqual(parseInline('[docs](https://example.com/a_(b))'), [{ t: 'link', href: 'https://example.com/a_(b)', children: [{ t: 'text', v: 'docs' }] }]);
    assert.deepEqual(parseInline('see https://example.com/x.'), [{ t: 'text', v: 'see ' }, { t: 'link', href: 'https://example.com/x', children: [{ t: 'text', v: 'https://example.com/x' }] }, { t: 'text', v: '.' }]);
    assert.deepEqual(parseInline('(https://a.example/b)'), [{ t: 'text', v: '(' }, { t: 'link', href: 'https://a.example/b', children: [{ t: 'text', v: 'https://a.example/b' }] }, { t: 'text', v: ')' }]);
    assert.deepEqual(parseInline('<https://x.example>'), [{ t: 'link', href: 'https://x.example', children: [{ t: 'text', v: 'https://x.example' }] }]);
    assert.equal(parseInline('www.example.com')[0].href, 'https://www.example.com');
    assert.equal(trimUrl('https://w.example/wiki/A_(b))'), 'https://w.example/wiki/A_(b)');
  });
  test('only http(s) and mailto become links; anything else stays its text', () => {
    assert.deepEqual(parseInline('[x](javascript:alert(1))'), [{ t: 'text', v: 'x' }]);
    assert.deepEqual(parseInline('[x](file:///etc/passwd)'), [{ t: 'text', v: 'x' }]);
    assert.deepEqual(parseInline('[x](/relative)'), [{ t: 'text', v: 'x' }]);
    assert.equal(safeHref('mailto:a@b.example'), 'mailto:a@b.example');
    assert.equal(safeHref('data:text/html,hi'), null);
    assert.equal(safeHref('HTTPS://EXAMPLE.COM'), 'HTTPS://EXAMPLE.COM');
  });
  test('a long text with many tokens, or many unclosed markers, parses in about linear time', () => {
    const s = Array.from({ length: 4000 }, (_, i) => `word \`c${i}\` **b${i}** _e${i}_`).join(' ');
    let t0 = performance.now(); const out = parseInline(s); let ms = performance.now() - t0;
    assert.equal(out.filter((x) => x.t === 'code').length, 4000);
    assert.ok(ms < 400, `took ${ms.toFixed(0)} ms`);
    const u = Array.from({ length: 4000 }, (_, i) => `a **b${i} c \`x ~~y`).join(' ');
    t0 = performance.now(); parseInline(u); ms = performance.now() - t0;
    assert.ok(ms < 400, `unclosed markers took ${ms.toFixed(0)} ms`);
  });
});

describe('plain text', () => {
  test('an excerpt keeps the words and drops the markers', () => {
    assert.equal(mdText('Two sessions wait: **demo-build** wants `npm test`.\n\n- one\n- [two](https://x.example)'), 'Two sessions wait: demo-build wants npm test. one; two');
    assert.equal(mdText('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |'), 'Title a b; 1 2');
    assert.equal(mdText(''), '');
  });
});
