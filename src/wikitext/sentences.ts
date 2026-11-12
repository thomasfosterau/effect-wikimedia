/**
 * The sentence view over parsed wikitext (#209): a {@link Paragraph}'s plain
 * text cut into sentences by the runtime's `Intl.Segmenter`, for a locale the
 * caller names. The view adds no splitting rules of its own; where a
 * sentence ends is the Unicode sentence-boundary algorithm's call, as the
 * runtime's ICU data tailors it to the locale.
 *
 * @copyright Thomas Foster
 * @module wikitext/sentences
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { Paragraph } from "./paragraphs.ts";

/** One sentence of a paragraph's text. */
export interface Sentence {
  /** The sentence, trimmed: never empty. */
  readonly text: string;
  /**
   * Where {@link Sentence.text} starts in the paragraph's
   * {@link Paragraph.text}, in UTF-16 code units, so
   * `paragraph.text.slice(start, end) === text`.
   */
  readonly start: number;
  /** Where {@link Sentence.text} ends in the paragraph's {@link Paragraph.text}, exclusive. */
  readonly end: number;
}

/** Options for {@link sentences}. */
export interface SentencesOptions {
  /**
   * The language the paragraph is written in, as a BCP 47 tag (`"en"`,
   * `"de"`, `"ja"`), which picks the segmenter's rules. Pass the wiki's
   * content language (`Action.getPageMetadata`'s `language` for the page).
   * A tag the runtime has no data for falls back to its default locale, as
   * `Intl.Segmenter` does; a malformed tag throws a `RangeError`.
   */
  readonly locale: string;
}

/**
 * Splits a paragraph's plain text into sentences, in order, with
 * `Intl.Segmenter`'s `sentence` granularity for `options.locale`. Each
 * sentence is trimmed and carries its offsets in {@link Paragraph.text};
 * whitespace between sentences belongs to none.
 *
 * The boundaries are the Unicode sentence-boundary algorithm's (UAX #29),
 * which breaks after a full stop followed by a space and an upper-case
 * letter, so an abbreviation such as `Mr. Adams` splits. ICU's
 * abbreviation suppressions (the `-u-ss-standard` locale extension) are not
 * applied by V8, and this view adds no rules of its own: merge sentences
 * yourself when a known abbreviation ends one. Pure, given the runtime's
 * locale data.
 */
export function sentences(paragraph: Paragraph, options: SentencesOptions): readonly Sentence[] {
  const segmenter = new Intl.Segmenter(options.locale, { granularity: "sentence" });
  return Arr.getSomes(
    Arr.map(Arr.fromIterable(segmenter.segment(paragraph.text)), ({ segment, index }) => {
      const text = segment.trim();
      if (Str.isEmpty(text)) return Option.none();
      const start = index + segment.indexOf(text);
      return Option.some<Sentence>({ text, start, end: start + text.length });
    }),
  );
}
