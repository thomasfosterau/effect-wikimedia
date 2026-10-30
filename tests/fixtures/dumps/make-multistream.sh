#!/bin/sh
# Regenerates multistream.xml.bz2 and multistream-index.txt.bz2, a tiny
# synthetic stand-in for Wikimedia's pages-articles-multistream dump (#211).
# Run from this directory with bzip2 1.0.8: `sh make-multistream.sh`.
#
# Like the real dump, the .xml.bz2 is a concatenation of independent bzip2
# streams: a header stream (<mediawiki> + <siteinfo>, not in the index), page
# streams of up to two <page>s each (Wikimedia writes 100), and a trailer
# stream (</mediawiki>, not in the index). Each index line is
# `offset:pageId:title`, where offset is the byte offset of the page's bzip2
# stream in the .xml.bz2 and the title is XML-escaped as in the XML.
set -eu
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# page <id> <title, XML-escaped> <ns> <text, XML-escaped>
page() {
  printf '  <page>\n    <title>%s</title>\n    <ns>%s</ns>\n    <id>%s</id>\n' "$2" "$3" "$1"
  printf '    <revision>\n      <id>%s</id>\n      <timestamp>2024-01-01T00:00:00Z</timestamp>\n' "$(($1 + 1000))"
  printf '      <model>wikitext</model>\n      <format>text/x-wiki</format>\n'
  printf '      <text bytes="1" xml:space="preserve">%s</text>\n    </revision>\n  </page>\n' "$4"
}

# index <offset> <id> <title, XML-escaped>
index() {
  printf '%s:%s:%s\n' "$1" "$2" "$3" >> "$work/index.txt"
}

printf '<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/" version="0.11" xml:lang="en">\n' > "$work/0.xml"
printf '  <siteinfo>\n    <sitename>Synthetic</sitename>\n    <dbname>syntheticwiki</dbname>\n' >> "$work/0.xml"
printf '    <namespaces>\n      <namespace key="0" case="first-letter" />\n' >> "$work/0.xml"
printf '      <namespace key="14" case="first-letter">Category</namespace>\n    </namespaces>\n  </siteinfo>\n' >> "$work/0.xml"

: > "$work/index.txt"
bzip2 -1 -c "$work/0.xml" > multistream.xml.bz2

offset=$(wc -c < multistream.xml.bz2 | tr -d ' ')
{ page 10 'Ada Lovelace' 0 "'''Ada''' wrote the first program."; page 12 'AT&amp;T' 0 'A company &amp; more.'; } > "$work/1.xml"
index "$offset" 10 'Ada Lovelace'
index "$offset" 12 'AT&amp;T'
bzip2 -1 -c "$work/1.xml" >> multistream.xml.bz2

offset=$(wc -c < multistream.xml.bz2 | tr -d ' ')
{ page 15 'Category:Writers' 14 'Writers.'; page 21 'Talk:Foo:Bar' 1 'A talk page.'; } > "$work/2.xml"
index "$offset" 15 'Category:Writers'
index "$offset" 21 'Talk:Foo:Bar'
bzip2 -1 -c "$work/2.xml" >> multistream.xml.bz2

offset=$(wc -c < multistream.xml.bz2 | tr -d ' ')
page 30 'Zebra' 0 'Striped.' > "$work/3.xml"
index "$offset" 30 'Zebra'
bzip2 -1 -c "$work/3.xml" >> multistream.xml.bz2

printf '</mediawiki>\n' > "$work/4.xml"
bzip2 -1 -c "$work/4.xml" >> multistream.xml.bz2

bzip2 -1 -c "$work/index.txt" > multistream-index.txt.bz2
