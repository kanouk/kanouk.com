import Accordion from "./Accordion.astro";
import Album from "./Album.astro";
import Callout from "./Callout.astro";
import Dialogue from "./Dialogue.astro";
import Embed from "./Embed.astro";
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
	"yohaku.dialogue": Dialogue,
	"yohaku.embed": Embed,
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
