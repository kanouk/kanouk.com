import Accordion from "./Accordion.astro";
import Album from "./Album.astro";
import Callout from "./Callout.astro";
import Code from "./Code.astro";
import Dialogue from "./Dialogue.astro";
import Embed from "./Embed.astro";
import LegacyEmbed from "./LegacyEmbed.astro";
import Gallery from "./Gallery.astro";
import LinkCard from "./LinkCard.astro";
import ProductCard from "./ProductCard.astro";
import Photo from "./Photo.astro";
import Quote from "./Quote.astro";
import Rating from "./Rating.astro";
import Quiz from "./Quiz.astro";
import SiteSearch from "./SiteSearch.astro";
import Steps from "./Steps.astro";
import YouTube from "./YouTube.astro";

export const blockComponents = {
	"yohaku.accordion": Accordion,
	"yohaku.album": Album,
	"yohaku.callout": Callout,
	// EmDash's code block hard-codes a dark panel; this one is drawn by the site theme.
	code: Code,
	"yohaku.dialogue": Dialogue,
	"yohaku.embed": Embed,
	embed: LegacyEmbed,
	gallery: Gallery,
	"yohaku.linkCard": LinkCard,
	"yohaku.productCard": ProductCard,
	"yohaku.photo": Photo,
	"yohaku.quote": Quote,
	"yohaku.rating": Rating,
	"yohaku.quiz": Quiz,
	"yohaku.siteSearch": SiteSearch,
	"yohaku.steps": Steps,
	"yohaku.youtube": YouTube,
};
