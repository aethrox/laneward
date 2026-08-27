"""Give every built locale its own copy of the sitemap.

Material's language-alternate helper reads the `<link rel="alternate">` tags
that mkdocs-static-i18n puts in every page head and fetches `sitemap.xml`
relative to each hreflang base, so the Turkish tree is asked for
`/tr/sitemap.xml`. The plugin builds all locales into one `site_dir` and writes
a single sitemap at the root, and that sitemap already lists both trees with
their alternates, so nothing answers that request and it returns 404.

Copy the sitemap the build produced into each non-default locale directory.
The helper then finds the Turkish URLs where it looks for them, and the site
still ships one authoritative sitemap rather than a hand-written second one.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import mkdocs.plugins


# Runs after mkdocs-static-i18n's own on_post_build (priority -100), which is
# what builds the non-default locale directories in the first place.
@mkdocs.plugins.event_priority(-110)
def on_post_build(config) -> None:
    i18n = config.plugins.get("i18n")
    if i18n is None:
        return

    site_dir = Path(config.site_dir)
    locales = [
        language.locale
        for language in i18n.config.languages
        if language.build and not language.default
    ]

    for name in ("sitemap.xml", "sitemap.xml.gz"):
        source = site_dir / name
        if not source.is_file():
            continue
        for locale in locales:
            destination = site_dir / locale
            if destination.is_dir():
                shutil.copyfile(source, destination / name)
