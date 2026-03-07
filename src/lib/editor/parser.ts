interface Token {
	text: string;
	bold: boolean;
	italic: boolean;
}

interface Line {
	tokens: Token[];
	listLevel: number;
	headingLevel: number;
}

export function parseLine(raw: string): Line {
	let headingLevel = 0;
	let listLevel = 0;
	let toBeParsed = raw;
	const tokens: Token[] = [];

	const listMatch = raw.match(/^((?:    )*)- /);
	if (listMatch) {
		const spaces = listMatch[1].length;
		listLevel = spaces / 4 + 1;
		tokens.push({
			text: listMatch[0],
			bold: false,
			italic: false
		});
		toBeParsed = raw.slice(listMatch[0].length);
	}

	const headingMatch = raw.match(/^(#{1,6})\s+/);
	if (headingMatch) {
		headingLevel = headingMatch[1].length;
		tokens.push({
			text: headingMatch[0],
			bold: true,
			italic: false
		});
		toBeParsed = raw.slice(headingMatch[0].length);
	}

	tokens.push(...parseInline(toBeParsed, headingLevel > 0));

	return { tokens, listLevel, headingLevel };
}

function parseInline(raw: string, forceBold = false): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < raw.length) {
		if (raw.startsWith('***', i)) {
			const close = raw.indexOf('***', i + 3);
			if (close !== -1 && raw[i + 3] !== ' ' && raw[close - 1] !== ' ') {
				tokens.push({ text: raw.slice(i, close + 3), bold: true, italic: true });
				i = close + 3;
				continue;
			}
		}

		if (raw.startsWith('**', i)) {
			const close = raw.indexOf('**', i + 2);
			if (close !== -1 && raw[i + 2] !== ' ' && raw[close - 1] !== ' ') {
				tokens.push({ text: raw.slice(i, close + 2), bold: true, italic: false });
				i = close + 2;
				continue;
			}
		}

		if (raw[i] === '*') {
			const close = raw.indexOf('*', i + 1);
			if (close !== -1 && raw[i + 1] !== ' ' && raw[close - 1] !== ' ') {
				tokens.push({ text: raw.slice(i, close + 1), bold: false, italic: true });
				i = close + 1;
				continue;
			}
			tokens.push({ text: '*', bold: forceBold, italic: false });
			i += 1;
			continue;
		}

		let nextStar = raw.indexOf('*', i);
		if (nextStar === -1) nextStar = raw.length;
		tokens.push({ text: raw.slice(i, nextStar), bold: forceBold, italic: false });
		i = nextStar;
	}

	return tokens;
}

export function renderLine(line: Line): string {
	// Check if the line has no visible text content
	const textContent = line.tokens.map((t) => t.text).join('');
	const isEmpty = textContent.length === 0;

	let html = line.tokens
		.map((token) => {
			let t = token.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			if (token.bold) t = `<strong>${t}</strong>`;
			if (token.italic) t = `<em>${t}</em>`;
			return t;
		})
		.join('');

	// Empty lines need a <br> so contenteditable keeps them interactive
	if (isEmpty) html = '<br>';

	if (line.listLevel > 0) {
		html = `<li class="line list" style="--list-level: ${line.listLevel - 1}">${html}</li>`;
	} else if (line.headingLevel > 0) {
		html = `<h${line.headingLevel} class="line heading">${html}</h${line.headingLevel}>`;
	} else {
		html = `<p class="line">${html}</p>`;
	}

	return html;
}

export function parseText(raw: string): Line[] {
	return raw.split('\n').map(parseLine);
}
