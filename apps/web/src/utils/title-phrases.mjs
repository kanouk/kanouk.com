/**
 * Splits a Japanese title into phrases that may each start a line.
 *
 * Intl.Segmenter's word boundaries put particles, okurigana and closing
 * punctuation in their own segment, so a title could wrap as "…「人間」" /
 * "のマネジメント". Here a run of hiragana (particles, endings) and a closing
 * bracket or punctuation join the phrase before it, and an opening bracket
 * joins the phrase after it. Hiragana after 、 or 。 starts a new phrase.
 */
const HIRAGANA = /^[\p{Script=Hiragana}ー]+$/u;
const CLOSING = /^[、。，．,.・：:；;？！?!」』）)】〕〉》〙〛"”’…〜]/u;
const OPENING = /[「『（(【〔〈《〘〚"“‘]$/u;
const SENTENCE_END = /[、。，．,.！？!?]$/u;

/** @param {string} title */
export function titlePhrases(title) {
	const words = Array.from(new Intl.Segmenter("ja", { granularity: "word" }).segment(title), ({ segment }) => segment);
	/** @type {string[]} */
	const phrases = [];
	for (const word of words) {
		const previous = phrases.at(-1);
		const joinsPrevious = previous !== undefined && !/\s$/u.test(previous) && !/^\s/u.test(word) &&
			(CLOSING.test(word) || OPENING.test(previous) || (HIRAGANA.test(word) && !SENTENCE_END.test(previous)));
		if (joinsPrevious) phrases[phrases.length - 1] = previous + word;
		else phrases.push(word);
	}
	return phrases;
}
