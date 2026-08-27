"""Drop the per-page hreflang link tags that Material turns into 404s.

Material's language-alternate helper reads every `<link rel="alternate">` in the
page head and fetches `sitemap.xml` relative to that href, expecting each one to
point at a language's site root, which is what the theme's own `extra.alternate`
contract asks for. mkdocs-static-i18n does not honour that contract: its
`reconfigure_page_context` rewrites every alternate link to the current page's
translation so the header language switcher jumps to the same page in the other
language. On `/guide/plans-and-authority/` that makes the helper ask for
`/guide/plans-and-authority/sitemap.xml`, which no build ever produces. The two
home pages escape it only because the plugin returns early for `page.url == "."`
and leaves the locale-root links in place there.

The contextual switcher is worth keeping and the helper is redundant next to it,
so remove the helper's input instead. The hreflang annotations are not lost: the
generated sitemap already carries a complete `xhtml:link rel="alternate"
hreflang=...` set for every URL in both trees, which is one of the ways search
engines are meant to receive them.

The header language switcher renders from `config.extra.alternate` and never
reads these head tags, so it keeps working.
"""

from __future__ import annotations

import re

import mkdocs.plugins

# Only the hreflang flavour. An RSS alternate carries a `type` attribute right
# after `rel`, so it cannot match.
HREFLANG_LINK = re.compile(r'\n\s*<link rel="alternate" href="[^"]*" hreflang="[^"]*">')


@mkdocs.plugins.event_priority(-100)
def on_post_page(output: str, page, config) -> str:
    return HREFLANG_LINK.sub("", output)


@mkdocs.plugins.event_priority(-100)
def on_post_template(output: str, template_name: str, config) -> str:
    # 404.html is a theme template rather than a page, so it never reaches
    # on_post_page. It inherits whatever alternates the last rendered page left
    # behind, which is both wrong and another pair of 404 sitemap requests.
    # The sitemap's own xhtml:link alternates have a different shape and are
    # left alone, but restrict this to HTML anyway.
    if not template_name.endswith(".html"):
        return output
    return HREFLANG_LINK.sub("", output)


if __name__ == "__main__":
    sample = (
        '<link rel="canonical" href="https://example.test/">\n'
        '    <link rel="alternate" href="./" hreflang="en">\n'
        '    <link rel="alternate" href="../../tr/guide/x/" hreflang="tr">\n'
        '    <link rel="alternate" type="application/rss+xml" title="f" href="feed.xml">\n'
        '    <link rel="icon" href="/favicon.png">'
    )
    stripped = HREFLANG_LINK.sub("", sample)
    assert "hreflang" not in stripped, stripped
    assert stripped.count("<link") == 3, stripped
    assert 'rel="canonical"' in stripped, stripped
    assert "rss+xml" in stripped, stripped
    assert 'rel="icon"' in stripped, stripped
    print("ok")
