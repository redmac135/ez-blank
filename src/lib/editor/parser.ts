interface Token {
	text: string;
	bold: boolean;
	italic: boolean;
}

interface Line {
	tokens: Token[];
	listLevel: number; // 0 for not a list, 1 for first level, 2 for nested list, etc.
	headingLevel: number; // 0 for not a heading, 1 for h1, 2 for h2, etc.
}

export function parseLine(raw: string): Line {
	let headingLevel = 0;
	let listLevel = 0;
	let toBeParsed = raw;
	const tokens = [];

	// check for lists
	const listMatch = raw.match(/^(\t*)- /);
	if (listMatch) {
		const tabs = listMatch[1].length;
		listLevel = tabs + 1;
		tokens.push({
			text: listMatch[0], // include the space after the dash
			bold: false,
			italic: false
		});

		toBeParsed = raw.slice(listMatch[0].length);
	}

	// check of headings
	const headingMatch = raw.match(/^(#{1,6})\s+/);
	if (headingMatch) {
		headingLevel = headingMatch[1].length;
		tokens.push({
			text: headingMatch[0], // include the space after the hashes
			bold: true,
			italic: false
		});

		toBeParsed = raw.slice(headingMatch[0].length);
	}

	tokens.push(...parseInline(toBeParsed, headingLevel > 0)); // force bold for headings

	return { tokens, listLevel, headingLevel };
}

function parseInline(raw: string, forceBold = false): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < raw.length) {
		// Try *** (bold + italic)
		if (raw.startsWith('***', i)) {
			const close = raw.indexOf('***', i + 3);

			if (close !== -1 && raw[i + 3] !== ' ' && raw[close - 1] !== ' ') {
				const full = raw.slice(i, close + 3);
				tokens.push({ text: full, bold: true, italic: true });
				i = close + 3;
				continue;
			}
		}

		// Try ** (bold)
		if (raw.startsWith('**', i)) {
			const close = raw.indexOf('**', i + 2);

			if (close !== -1 && raw[i + 2] !== ' ' && raw[close - 1] !== ' ') {
				const full = raw.slice(i, close + 2);
				tokens.push({ text: full, bold: true, italic: false });
				i = close + 2;
				continue;
			}
		}

		// Try * (italic)
		if (raw[i] === '*') {
			const close = raw.indexOf('*', i + 1);

			if (close !== -1 && raw[i + 1] !== ' ' && raw[close - 1] !== ' ') {
				const full = raw.slice(i, close + 1);
				tokens.push({ text: full, bold: false, italic: true });
				i = close + 1;
				continue;
			}

			// If invalid italic → treat single * as normal char
			tokens.push({
				text: '*',
				bold: forceBold,
				italic: false
			});
			i += 1;
			continue;
		}

		// Normal text chunk
		let nextStar = raw.indexOf('*', i);
		if (nextStar === -1) nextStar = raw.length;

		const normal = raw.slice(i, nextStar);

		tokens.push({
			text: normal,
			bold: forceBold,
			italic: false
		});

		i = nextStar;
	}

	return tokens;
}

export function renderLine(line: Line): string {
	let html = line.tokens
		.map((token) => {
			let t = token.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			if (token.bold) t = `<strong>${t}</strong>`;
			if (token.italic) t = `<em>${t}</em>`;
			return t;
		})
		.join('');

	return html;
}

export function parseText(raw: string): Line[] {
	return raw.split('\n').map(parseLine);
}

