/** The floating buttons on an article: a contents list and a way back to the top. */
const float = document.querySelector<HTMLElement>("[data-article-float]");
const lead = document.querySelector(".article-lead");
const index = document.getElementById("article-index");
const list = document.querySelector("[data-article-index]");

if (float && lead) {
	new IntersectionObserver(([entry]) => {
		float.classList.toggle("is-visible", !entry?.isIntersecting);
	}).observe(lead);
}

document.querySelector("[data-article-top]")?.addEventListener("click", () => {
	const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
	window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
});

const headings = document.querySelectorAll<HTMLElement>(".article-content :is(h2, h3, h4)");
if (index && list && headings.length > 0) {
	headings.forEach((heading, position) => {
		if (!heading.id) heading.id = `section-${position}`;
		const item = document.createElement("li");
		item.className = `article-index__item article-index__item--${heading.tagName.toLowerCase()}`;
		const link = document.createElement("a");
		link.href = `#${heading.id}`;
		link.textContent = heading.textContent;
		link.addEventListener("click", () => index.hidePopover());
		item.append(link);
		list.append(item);
	});
	document.querySelector<HTMLElement>("[data-article-index-button]")?.removeAttribute("hidden");
}
