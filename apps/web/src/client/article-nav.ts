/** The floating buttons on an article: a contents list and a way back to the top. */
const float = document.querySelector<HTMLElement>("[data-article-float]");
const lead = document.querySelector(".article-lead");
const index = document.getElementById("article-index");
const list = document.querySelector("[data-article-index]");

if (float && lead) {
	// Shown once the title has scrolled away, never over the footer. On phones the buttons sit over the
	// text column, so they only come back while the reader scrolls up (looking for the way back).
	const narrow = matchMedia("(max-width: 48rem)");
	const footer = document.querySelector(".site-footer");
	let pastLead = false;
	let footerInView = false;
	let scrollingUp = false;
	let lastY = scrollY;
	const update = () => {
		float.classList.toggle("is-visible", pastLead && !footerInView && (!narrow.matches || scrollingUp));
	};
	new IntersectionObserver(([entry]) => {
		pastLead = !entry?.isIntersecting;
		update();
	}).observe(lead);
	if (footer) {
		new IntersectionObserver(([entry]) => {
			footerInView = Boolean(entry?.isIntersecting);
			update();
		}).observe(footer);
	}
	addEventListener("scroll", () => {
		const y = scrollY;
		if (Math.abs(y - lastY) < 12) return;
		scrollingUp = y < lastY;
		lastY = y;
		update();
	}, { passive: true });
	narrow.addEventListener("change", update);
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
