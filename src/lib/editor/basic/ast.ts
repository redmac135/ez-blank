export interface SourceRange {
	start: number;
	end: number;
}

export interface TextNode {
	type: 'text';
	range: SourceRange;
	text: string;
}

export interface FormattedNode {
	type: 'emphasis' | 'strong' | 'strong_emphasis' | 'code';
	range: SourceRange;
	contentRange: SourceRange;
	marker: string;
	text: string;
}

export type InlineNode = TextNode | FormattedNode;

export interface ParagraphBlock {
	type: 'paragraph';
	range: SourceRange;
	raw: string;
	inline: InlineNode[];
}

export interface HeadingBlock {
	type: 'heading';
	range: SourceRange;
	raw: string;
	level: number;
	prefix: string;
	inline: InlineNode[];
}

export interface CodeBlock {
	type: 'code_block';
	range: SourceRange;
	language: string | null;
	openFence: string;
	closeFence: string | null;
	lines: Array<{
		range: SourceRange;
		text: string;
	}>;
}

export interface ListItemBlock {
	type: 'list_item';
	range: SourceRange;
	lineRange: SourceRange;
	level: number;
	ordered: boolean;
	number: number;
	prefix: string;
	raw: string;
	inline: InlineNode[];
	children: BlockNode[];
}

export interface ListBlock {
	type: 'list';
	range: SourceRange;
	level: number;
	ordered: boolean;
	items: ListItemBlock[];
}

export type BlockNode = ParagraphBlock | HeadingBlock | CodeBlock | ListBlock;
