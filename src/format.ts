export type FormattedText = { plain: string; html: string };

const escape = Bun.escapeHTML;
const entities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#124;": "|",
  "&#58;": ":",
  "&#60;": "<",
};
const stripTags = (text: string) =>
  text.replace(/<\/?(?:a|b|i|s|tg-spoiler|pre|code)(?: [^>]*)?>/g, "");

function plainText(html: string): string {
  return stripTags(
    html.replace(
      /<a href="([^"]+)">([\s\S]*?)<\/a>/g,
      (_, href: string, label: string) => {
        const visible = stripTags(label);
        return visible === href || "https://" + visible === href
          ? label
          : `${label} (${href})`;
      },
    ),
  ).replace(
    /&(?:amp|lt|gt|quot|#x27|#124|#58|#60);/g,
    (entity) => entities[entity]!,
  );
}

function balancedStyles(text: string): boolean {
  const stack: string[] = [];
  for (const [, closing, tag] of text.matchAll(/<(\/?)([bis])>/g)) {
    if (!closing) stack.push(tag!);
    else if (stack.pop() !== tag) return false;
  }
  return stack.length === 0;
}

export function formatContent(
  content: string,
  attachmentUrls: readonly string[],
  roleNames?: ReadonlyMap<string, string>,
): FormattedText {
  const source = content.replace(/\r\n?/g, "\n");
  const words = source.split(/\s+/);
  const duplicateLinks = new Set(
    attachmentUrls.filter((url) => {
      const standalone = words.filter(
        (word) => word === url || word === `<${url}>`,
      ).length;
      return standalone > 0 && source.split(url).length === standalone + 1;
    }),
  );

  // Keep code, link destinations and role names out of the Discord cleanup.
  const prefix = `\uE000${crypto.randomUUID()}`;
  const pieces: string[] = [];
  const marker = new RegExp(`${prefix}([cv])(\\d+)\uE001`, "g");
  const codeMarker = new RegExp(`(${prefix}c\\d+\uE001)`, "g");
  const protect = (html: string, kind = "v") =>
    `${prefix}${kind}${pieces.push(html) - 1}\uE001`;
  const restore = (text: string, stripCode = false) =>
    text.replace(marker, (_, kind: string, index: string) => {
      const html = pieces[Number(index)]!;
      return stripCode && kind === "c" ? stripTags(html) : html;
    });

  function style(tag: string, text: string): string {
    // Telegram doesn't allow code entities inside other inline styles.
    return text
      .split(codeMarker)
      .map((part, index) =>
        index % 2 || !part.trim() ? part : `<${tag}>${part}</${tag}>`,
      )
      .join("");
  }

  function clean(text: string): string {
    return text
      .replace(/(?<![\w/]):[a-z\d_+-]+:(?![\w/])/gi, "")
      .replace(
        /&lt;(?:@&amp;(\d+)|a?:[a-z\d_~-]+:\d+|\d{6,})&gt;/gi,
        (_, roleId: string | undefined) =>
          roleId
            ? protect(escape("@" + (roleNames?.get(roleId) ?? roleId)))
            : "",
      )
      .replace(
        /(?<!\|)\|\|(?!\|)([\s\S]+?)(?<!\|)\|\|(?!\|)/g,
        (match, body: string) =>
          balancedStyles(body)
            ? `<tg-spoiler>${restore(body, true)}</tg-spoiler>`
            : match,
      );
  }

  function link(label: string, href: string): string {
    const direct = label === escape(href);
    const url = /^www\./i.test(href) ? "https://" + href : href;
    if (!direct) label = clean(label);
    if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return label;
    if (direct && duplicateLinks.has(href)) return "";
    // Nested images and inline code can supply labels, but not nested link or code entities.
    const text = restore(label, true).replace(/<\/?a(?: href="[^"]*")?>/g, "");
    return protect(`<a href="${escape(url)}">${text || escape(href)}</a>`);
  }

  const rendered = Bun.markdown.render(
    source,
    {
      text: (value) =>
        /^[|:<]$/.test(value) ? `&#${value.charCodeAt(0)};` : escape(value),
      html: escape,
      paragraph: (text) => text + "\n\n",
      heading: (text) => style("b", text) + "\n\n",
      strong: (text) => style("b", text),
      emphasis: (text) => style("i", text),
      strikethrough: (text) => style("s", text),
      code: (text, meta) => {
        const language = meta?.language?.match(/^[\w+-]+(?=\s|$)/)?.[0];
        const attribute = language ? ` class="language-${language}"` : "";
        return (
          protect(`<pre><code${attribute}>${text}</code></pre>`, "c") + "\n\n"
        );
      },
      codespan: (text) => protect(`<code>${text}</code>`, "c"),
      listItem: (text, { index, depth, ordered, start }) => {
        const bullet = ordered ? `${(start ?? 1) + index}.` : "•";
        return `${"  ".repeat(depth)}${bullet} ${text.trimEnd()}\n`;
      },
      list: (text, { depth }) => (depth ? "\n" + text : text + "\n"),
      link: (text, { href }) => link(text, href),
      image: (text, { src }) => link(text, src),
      blockquote: (text) => text.trimEnd() + "\n\n",
      hr: () => "---\n\n",
    },
    {
      autolinks: { url: true, www: true },
      hardSoftBreaks: true,
      noHtmlBlocks: true,
      noIndentedCodeBlocks: true,
      tables: false,
      tasklists: false,
    },
  );
  const html = restore(clean(rendered).trim());
  return { plain: plainText(html), html };
}
