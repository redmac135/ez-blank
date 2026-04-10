<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import Editor from '$lib/Editor.svelte';
	import FloatingMenu from '$lib/FloatingMenu.svelte';
	import {
		applyEditorStateUpdate,
		applyHydratedSession,
		applySessionUpdate
	} from '$lib/editor/app-state';
	import {
		cycleCountVisibility,
		DEFAULT_PREFERENCES,
		getCountVisibilityLabel,
		normalizePreferences,
		type CountVisibility,
		type EditorPreferences,
		type ThemeMode
	} from '$lib/editor/preferences';
	import { type EditorState } from '$lib/editor/history';
	import { EditorStorage } from '$lib/editor/storage';
	import {
		createPage,
		createSession,
		type EditorPage,
		type EditorSession,
		updatePageState,
		updatePageTitle
	} from '$lib/editor/session';

	let session: EditorSession = createSession();
	let drawerOpen = false;
	let loaded = false;
	let menuPageId: string | null = null;
	let editingPageId: string | null = null;
	let deletePageId: string | null = null;
	let titleDraft = '';
	let titleInput: HTMLInputElement | null = null;
	let countButton: HTMLButtonElement | null = null;
	let settingsButton: HTMLButtonElement | null = null;
	let countMenuOpen = false;
	let settingsMenuOpen = false;
	let countDisplayMode: 'words' | 'characters' | 'paragraphs' | 'lines' = 'words';
	let chromeVisible = true;
	let previousActiveText = '';
	let hideChromeTimeout: ReturnType<typeof setTimeout> | null = null;
	let preferences: EditorPreferences = DEFAULT_PREFERENCES;

	const TOP_REVEAL_HEIGHT = 112;
	const CHROME_HIDE_DELAY = 1400;
	const PREFERENCES_KEY = 'ez-blank-preferences-v1';

	$: activePage = getActivePage(session);
	$: activeText = activePage.content;
	$: hasDocumentContent = activeText.length > 0;
	$: wordCount = getWordCount(activeText);
	$: characterCount = activeText.length;
	$: paragraphCount = getParagraphCount(activeText);
	$: lineCount = getLineCount(activeText);
	$: countOptions = [
		{ id: 'words', label: pluralize(wordCount, 'word') },
		{ id: 'characters', label: pluralize(characterCount, 'character') },
		{ id: 'paragraphs', label: pluralize(paragraphCount, 'paragraph') },
		{ id: 'lines', label: pluralize(lineCount, 'line') }
	] as const;
	$: currentCountLabel =
		countOptions.find((option) => option.id === countDisplayMode)?.label ?? countOptions[0].label;
	$: countVisibleInChrome = preferences.countVisibility !== 'hidden';
	$: countPinnedVisible = preferences.countVisibility === 'pinned';
	$: countVisible = countVisibleInChrome && (chromeVisible || countPinnedVisible || countMenuOpen);
	$: countDockedRight = countPinnedVisible && !chromeVisible && !settingsMenuOpen;
	$: pageTheme = preferences.themeMode;

	$: if (!hasDocumentContent || drawerOpen || countMenuOpen || settingsMenuOpen) {
		revealChrome(true);
	}

	$: if (activeText !== previousActiveText) {
		const textIsEmpty = activeText.length === 0;
		previousActiveText = activeText;

		if (textIsEmpty) {
			revealChrome(true);
		} else if (!drawerOpen && !countMenuOpen) {
			chromeVisible = false;
			clearHideChromeTimeout();
		}
	}

	function getActivePage(currentSession: EditorSession): EditorPage {
		return (
			currentSession.pages.find((page) => page.id === currentSession.activePageId) ??
			currentSession.pages[0] ??
			createPage()
		);
	}

	function persistSession(nextSession: EditorSession) {
		const transition = applySessionUpdate({ session, loaded }, nextSession);
		session = transition.state.session;
		if (transition.persistedSession) {
			EditorStorage.save(transition.persistedSession);
		}
	}

	function updateActivePage(state: EditorState) {
		const transition = applyEditorStateUpdate({ session, loaded }, state);
		session = transition.state.session;
		if (transition.persistedSession) {
			EditorStorage.save(transition.persistedSession);
		}
	}

	function selectPage(pageId: string) {
		if (editingPageId) return;
		persistSession({
			...session,
			activePageId: pageId
		});
		menuPageId = null;
		drawerOpen = false;
	}

	function addPage() {
		const page = createPage();
		persistSession({
			pages: [...session.pages, page],
			activePageId: page.id
		});
		menuPageId = null;
		drawerOpen = false;
	}

	function closePage(pageId: string) {
		if (session.pages.length === 1) {
			const replacementPage = createPage();
			persistSession({
				pages: [replacementPage],
				activePageId: replacementPage.id
			});
			menuPageId = null;
			return;
		}

		const nextPages = session.pages.filter((page) => page.id !== pageId);
		const nextActivePageId =
			session.activePageId === pageId ? (nextPages[0]?.id ?? session.activePageId) : session.activePageId;

		persistSession({
			pages: nextPages,
			activePageId: nextActivePageId
		});
		menuPageId = null;
		deletePageId = null;
	}

	function toggleMenu(pageId: string) {
		if (editingPageId === pageId) return;
		menuPageId = menuPageId === pageId ? null : pageId;
	}

	async function startEditingTitle(pageId: string) {
		const page = session.pages.find((entry) => entry.id === pageId);
		if (!page) return;
		menuPageId = null;
		editingPageId = pageId;
		titleDraft = page.title;
		await tick();
		titleInput?.focus();
		titleInput?.select();
	}

	function confirmTitleEdit() {
		if (!editingPageId) return;

		const pageId = editingPageId;
		editingPageId = null;
		persistSession({
			...session,
			pages: session.pages.map((entry) =>
				entry.id === pageId ? updatePageTitle(entry, titleDraft) : entry
			)
		});
	}

	function cancelTitleEdit() {
		editingPageId = null;
		titleDraft = '';
	}

	function openDeleteModal(pageId: string) {
		menuPageId = null;
		deletePageId = pageId;
	}

	function closeDeleteModal() {
		deletePageId = null;
	}

	function handleStorage(event: StorageEvent) {
		if (event.key === PREFERENCES_KEY) {
			preferences = loadPreferences();
			return;
		}

		if (event.key === EditorStorage.STORAGE_KEY || event.key === EditorStorage.LEGACY_STORAGE_KEY) {
			session = EditorStorage.load();
		}
	}

	function getWordCount(value: string) {
		const trimmed = value.trim();
		return trimmed ? trimmed.split(/\s+/).length : 0;
	}

	function pluralize(count: number, label: string) {
		return `${count} ${label}${count === 1 ? '' : 's'}`;
	}

	function getParagraphCount(value: string) {
		const trimmed = value.trim();
		if (!trimmed) return 0;
		return trimmed.split(/\n\s*\n+/).filter(Boolean).length;
	}

	function getLineCount(value: string) {
		if (!value) return 0;
		return value.split('\n').length;
	}

	function clearHideChromeTimeout() {
		if (hideChromeTimeout) {
			clearTimeout(hideChromeTimeout);
			hideChromeTimeout = null;
		}
	}

	function scheduleChromeHide() {
		clearHideChromeTimeout();
		if (!hasDocumentContent || drawerOpen || countMenuOpen || settingsMenuOpen) return;

		hideChromeTimeout = setTimeout(() => {
			chromeVisible = false;
			hideChromeTimeout = null;
		}, CHROME_HIDE_DELAY);
	}

	function revealChrome(persist = false) {
		chromeVisible = true;
		if (persist) {
			clearHideChromeTimeout();
			return;
		}

		scheduleChromeHide();
	}

	function toggleCountMenu() {
		countMenuOpen = !countMenuOpen;
		settingsMenuOpen = false;
		if (countMenuOpen) {
			revealChrome(true);
			return;
		}

		scheduleChromeHide();
	}

	function selectCountDisplay(
		nextMode: 'words' | 'characters' | 'paragraphs' | 'lines'
	) {
		countDisplayMode = nextMode;
		countMenuOpen = false;
		scheduleChromeHide();
	}

	function toggleSettingsMenu() {
		settingsMenuOpen = !settingsMenuOpen;
		countMenuOpen = false;
		if (settingsMenuOpen) {
			revealChrome(true);
			return;
		}

		scheduleChromeHide();
	}

	function updatePreferences(nextPreferences: EditorPreferences) {
		preferences = nextPreferences;
		savePreferences(nextPreferences);
	}

	function toggleThemeMode() {
		updatePreferences({
			...preferences,
			themeMode: preferences.themeMode === 'dark' ? 'light' : 'dark'
		});
	}

	function toggleSpellcheck() {
		updatePreferences({
			...preferences,
			spellcheckEnabled: !preferences.spellcheckEnabled
		});
	}

	function cycleWordCountVisibility() {
		updatePreferences({
			...preferences,
			countVisibility: cycleCountVisibility(preferences.countVisibility)
		});
	}

	function handleMouseMove(event: MouseEvent) {
		if (event.clientY <= TOP_REVEAL_HEIGHT) {
			revealChrome();
		}
	}

	function handleWindowPointerDown(event: MouseEvent) {
		const target = event.target;
		if (!(target instanceof Node)) return;

		if (countMenuOpen) {
			if (
				countButton?.contains(target) ||
				(target instanceof Element && target.closest('.count-control'))
			) {
				return;
			}
			countMenuOpen = false;
		}

		if (settingsMenuOpen) {
			if (
				settingsButton?.contains(target) ||
				(target instanceof Element && target.closest('.settings-control'))
			) {
				return;
			}
			settingsMenuOpen = false;
		}

		scheduleChromeHide();
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;

		if (countMenuOpen) {
			countMenuOpen = false;
			scheduleChromeHide();
		}

		if (settingsMenuOpen) {
			settingsMenuOpen = false;
			scheduleChromeHide();
		}

		if (drawerOpen) {
			drawerOpen = false;
			menuPageId = null;
		}
	}

	onMount(() => {
		const hydratedState = applyHydratedSession({ session, loaded }, EditorStorage.load());
		session = hydratedState.session;
		loaded = hydratedState.loaded;
		preferences = loadPreferences();
		previousActiveText = getActivePage(session).content;
		applyTheme(preferences.themeMode);
	});

	onDestroy(() => {
		clearHideChromeTimeout();
	});

	$: if (loaded) {
		applyTheme(pageTheme);
	}

	$: deletePage = deletePageId
		? session.pages.find((page) => page.id === deletePageId) ?? null
		: null;

	function loadPreferences(): EditorPreferences {
		try {
			const saved = localStorage.getItem(PREFERENCES_KEY);
			return saved ? normalizePreferences(JSON.parse(saved)) : DEFAULT_PREFERENCES;
		} catch (e) {
			console.error('Failed to load editor preferences:', e);
			return DEFAULT_PREFERENCES;
		}
	}

	function savePreferences(nextPreferences: EditorPreferences) {
		try {
			localStorage.setItem(PREFERENCES_KEY, JSON.stringify(nextPreferences));
		} catch (e) {
			console.error('Failed to save editor preferences:', e);
		}
	}

	function applyTheme(themeMode: ThemeMode) {
		document.body.dataset.theme = themeMode;
	}
</script>

<svelte:window
	on:beforeunload={() => EditorStorage.save(session)}
	on:storage={handleStorage}
	on:mousemove={handleMouseMove}
	on:mousedown={handleWindowPointerDown}
	on:keydown={handleWindowKeydown}
/>

<div class="page-shell">
	<div class:visible={loaded && chromeVisible} class="top-bar-shell">
		<div class="top-bar">
			<button
				class="drawer-toggle"
				type="button"
				aria-label={drawerOpen ? 'Close pages' : 'Open pages'}
				aria-expanded={drawerOpen}
				on:click={() => (drawerOpen = !drawerOpen)}
			>
				<span></span>
				<span></span>
			</button>
			<div class="settings-control">
				<button
					bind:this={settingsButton}
					class="settings-toggle"
					type="button"
					aria-haspopup="menu"
					aria-expanded={settingsMenuOpen}
					aria-label="Open editor settings"
					on:click={toggleSettingsMenu}
				>
					<span></span>
					<span></span>
					<span></span>
				</button>
				{#if settingsMenuOpen}
					<FloatingMenu label="Editor settings" verticalOffset="0.45rem">
						<button type="button" on:click={toggleThemeMode}>
							{preferences.themeMode === 'dark' ? 'Light mode' : 'Dark mode'}
						</button>
						<button type="button" on:click={toggleSpellcheck}>
							{preferences.spellcheckEnabled ? 'Spellcheck on' : 'Spellcheck off'}
						</button>
						<button
							type="button"
							aria-label={`Cycle word count visibility, currently ${getCountVisibilityLabel(preferences.countVisibility).toLowerCase()}`}
							on:click={cycleWordCountVisibility}
						>
							{getCountVisibilityLabel(preferences.countVisibility)}
						</button>
					</FloatingMenu>
				{/if}
			</div>
		</div>
	</div>

	<div
		class:count-visible={countVisible}
		class:docked-right={countDockedRight}
		class="count-shell"
	>
		{#if countVisibleInChrome}
			<div class="count-control">
				<button
					bind:this={countButton}
					class="count-toggle"
					type="button"
					aria-haspopup="menu"
					aria-expanded={countMenuOpen}
					aria-label={`Open count menu, currently showing ${currentCountLabel}`}
					on:click={toggleCountMenu}
				>
					{currentCountLabel}
				</button>
				{#if countMenuOpen}
					<FloatingMenu label="Count display options" verticalOffset="0.45rem">
						{#each countOptions as option}
							<button
								type="button"
								role="menuitemradio"
								aria-checked={option.id === countDisplayMode}
								on:click={() => selectCountDisplay(option.id)}
							>
								{option.label}
							</button>
						{/each}
					</FloatingMenu>
				{/if}
			</div>
		{/if}
	</div>

	{#if drawerOpen}
		<button
			class="scrim"
			type="button"
			aria-label="Close pages"
			on:click={() => {
				drawerOpen = false;
				menuPageId = null;
			}}
		></button>
	{/if}

	{#if deletePage}
		<button class="modal-scrim" type="button" aria-label="Close delete dialog" on:click={closeDeleteModal}></button>
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
			<h2 id="delete-title">Delete page?</h2>
			<p>{deletePage.title}</p>
			<div class="modal-actions">
				<button type="button" class="modal-button" on:click={closeDeleteModal}>Cancel</button>
				<button type="button" class="modal-button modal-button-delete" on:click={() => closePage(deletePage.id)}>
					Delete
				</button>
			</div>
		</div>
	{/if}

	<aside class:open={drawerOpen} class="drawer" aria-label="Pages">
		<div class="drawer-header">
			<h1>Pages</h1>
			<button type="button" class="add-page" aria-label="New page" on:click={addPage}>+</button>
		</div>

		<nav class="page-list" aria-label="Page tabs">
			{#each session.pages as page (page.id)}
				<div class:active={page.id === session.activePageId} class="page-row">
					{#if editingPageId === page.id}
						<div class="page-tab page-tab-editing">
							<input
								bind:this={titleInput}
								bind:value={titleDraft}
								class="title-input"
								type="text"
								aria-label="Edit page title"
								on:keydown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										confirmTitleEdit();
									}
									if (event.key === 'Escape') {
										event.preventDefault();
										cancelTitleEdit();
									}
								}}
							/>
							<button
								type="button"
								class="confirm-title"
								aria-label="Confirm title"
								on:click={confirmTitleEdit}
							>
								✓
							</button>
						</div>
					{:else}
						<button type="button" class="page-tab" on:click={() => selectPage(page.id)}>
							<span class="page-title">{page.title}</span>
						</button>
					{/if}
					<div class="page-actions">
						<button
							type="button"
							class="menu-toggle"
							aria-label={`Page menu for ${page.title}`}
							aria-expanded={menuPageId === page.id}
							on:click={() => toggleMenu(page.id)}
						>
							<span></span>
							<span></span>
							<span></span>
						</button>
						{#if menuPageId === page.id}
							<FloatingMenu label={`Page menu for ${page.title}`}>
								<button type="button" on:click={() => startEditingTitle(page.id)}>Edit title</button>
								<button type="button" on:click={() => openDeleteModal(page.id)}>Delete</button>
							</FloatingMenu>
						{/if}
					</div>
				</div>
			{/each}
		</nav>
	</aside>

	<section class="workspace">
		{#if loaded}
			{#key activePage.id}
				<Editor
					initialState={{
						text: activePage.content,
						selectionStart: activePage.selectionStart,
						selectionEnd: activePage.selectionEnd
					}}
					spellcheckEnabled={preferences.spellcheckEnabled}
					onChange={updateActivePage}
				/>
			{/key}
		{/if}
	</section>
</div>

<style>
	:global(body) {
		--page-background: #fff;
		--text-color: #111;
		--muted-text-color: rgba(0, 0, 0, 0.68);
		--subtle-text-color: rgba(0, 0, 0, 0.5);
		--surface-color: rgba(255, 255, 255, 0.94);
		--surface-border-color: rgba(0, 0, 0, 0.08);
		--surface-shadow-color: rgba(0, 0, 0, 0.06);
		--hover-background-color: rgba(0, 0, 0, 0.035);
		--chrome-scrim-color: rgba(255, 255, 255, 0.72);
		--modal-scrim-color: rgba(255, 255, 255, 0.8);
		--line-color: #111;
		--accent-background: rgba(0, 0, 0, 0.035);
		--editor-caret-color: #555;
		--editor-selection-color: rgba(180, 213, 255, 0.6);
		--editor-placeholder-color: #999;
		--editor-code-background: rgba(0, 0, 0, 0.04);
		--editor-muted-color: #666;
		margin: 0;
		background: var(--page-background);
		color: var(--text-color);
		font-family: 'Roboto Mono', monospace;
		transition:
			background-color 180ms ease,
			color 180ms ease;
	}

	:global(body[data-theme='dark']) {
		--page-background: #121314;
		--text-color: #f1f1ec;
		--muted-text-color: rgba(241, 241, 236, 0.7);
		--subtle-text-color: rgba(241, 241, 236, 0.62);
		--surface-color: rgba(26, 28, 30, 0.94);
		--surface-border-color: rgba(255, 255, 255, 0.12);
		--surface-shadow-color: rgba(0, 0, 0, 0.34);
		--hover-background-color: rgba(255, 255, 255, 0.06);
		--chrome-scrim-color: rgba(18, 19, 20, 0.78);
		--modal-scrim-color: rgba(18, 19, 20, 0.82);
		--line-color: #f1f1ec;
		--accent-background: rgba(255, 255, 255, 0.07);
		--editor-caret-color: #d9d9d2;
		--editor-selection-color: rgba(103, 141, 204, 0.45);
		--editor-placeholder-color: rgba(241, 241, 236, 0.42);
		--editor-code-background: rgba(255, 255, 255, 0.06);
		--editor-muted-color: rgba(241, 241, 236, 0.56);
	}

	.page-shell {
		position: relative;
		min-height: 100vh;
	}

	.top-bar-shell {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 20;
		padding:
			max(0.75rem, env(safe-area-inset-top))
			max(0.75rem, env(safe-area-inset-right))
			0
			max(0.75rem, env(safe-area-inset-left));
		opacity: 0;
		pointer-events: none;
		transition: opacity 180ms ease;
	}

	.top-bar-shell.visible {
		opacity: 1;
		pointer-events: auto;
	}

	.top-bar {
		position: relative;
		width: 100%;
		box-sizing: border-box;
		min-height: 2rem;
	}

	.settings-control,
	.count-shell {
		position: absolute;
		top: 0;
		right: 0;
	}

	.count-control {
		position: relative;
		min-width: 0;
	}

	.count-shell {
		z-index: 21;
		padding:
			max(0.75rem, env(safe-area-inset-top))
			max(0.75rem, env(safe-area-inset-right))
			0
			max(0.75rem, env(safe-area-inset-left));
		opacity: 0;
		pointer-events: none;
		transform: translateX(calc(-2.55rem));
		transition:
			opacity 180ms ease,
			transform 220ms ease;
	}

	.count-shell.count-visible {
		opacity: 1;
		pointer-events: auto;
	}

	.count-shell.docked-right {
		transform: translateX(0);
	}

	.count-toggle,
	.drawer-toggle,
	.settings-toggle {
		position: static;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.count-toggle {
		display: block;
		min-height: 2rem;
		max-width: min(12rem, calc(100vw - 6rem));
		padding: 0.45rem 0.75rem;
		border-radius: 999px;
		font: inherit;
		font-size: 0.75rem;
		letter-spacing: 0.02em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.count-control :global(.floating-menu) {
		min-width: max-content;
	}

	.count-control :global(.floating-menu button),
	.count-control :global(.floating-menu .menu-stat) {
		text-align: right;
	}

	.count-control :global(.floating-menu button[aria-checked='true']) {
		color: var(--subtle-text-color);
	}

	.drawer-toggle {
		width: 2rem;
		height: 2rem;
		padding: 0;
		border-radius: 999px;
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.28rem;
	}

	.drawer-toggle span {
		display: block;
		width: 1rem;
		height: 1px;
		background: var(--line-color);
	}

	.settings-control {
		position: absolute;
		top: 0;
		right: 0;
	}

	.settings-toggle {
		width: 2rem;
		height: 2rem;
		padding: 0;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.2rem;
	}

	.settings-toggle span {
		display: block;
		width: 3px;
		height: 3px;
		border-radius: 999px;
		background: var(--line-color);
	}

	.scrim {
		position: fixed;
		inset: 0;
		z-index: 10;
		border: 0;
		background: var(--chrome-scrim-color);
	}

	.modal-scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
		border: 0;
		background: var(--modal-scrim-color);
	}

	.modal {
		position: fixed;
		top: 50%;
		left: 50%;
		z-index: 31;
		width: min(22rem, calc(100vw - 2rem));
		padding: 1rem;
		box-sizing: border-box;
		background: var(--surface-color);
		border: 1px solid var(--surface-border-color);
		border-radius: 0.55rem;
		box-shadow: 0 18px 50px var(--surface-shadow-color);
		transform: translate(-50%, -50%);
	}

	.modal h2,
	.modal p {
		margin: 0;
	}

	.modal h2 {
		font-size: 0.9rem;
		font-weight: 400;
	}

	.modal p {
		margin-top: 0.45rem;
		font-size: 0.82rem;
		color: var(--muted-text-color);
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.45rem;
		margin-top: 1rem;
	}

	.modal-button {
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		padding: 0.5rem 0.75rem;
		border-radius: 0.35rem;
		cursor: pointer;
	}

	.modal-button:hover {
		background: var(--hover-background-color);
	}

	.modal-button-delete {
		background: #b42318;
		color: #fff;
	}

	.modal-button-delete:hover {
		background: #9f1f15;
	}

	.drawer {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		z-index: 25;
		width: min(18rem, 82vw);
		padding: 4.25rem 1rem 1rem;
		box-sizing: border-box;
		background: var(--surface-color);
		border-right: 1px solid var(--surface-border-color);
		transform: translateX(-100%);
		transition: transform 180ms ease;
	}

	.drawer.open {
		transform: translateX(0);
	}

	.drawer-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.drawer-header h1 {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 400;
	}

	.add-page,
	.page-tab,
	.menu-toggle,
	.confirm-title {
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.add-page,
	.menu-toggle {
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.page-list {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.page-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		border-radius: 0.35rem;
	}

	.page-row.active {
		background: var(--accent-background);
	}

	.page-tab {
		min-width: 0;
		padding: 0.55rem 0.65rem;
		text-align: left;
	}

	.page-tab-editing {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		padding: 0.35rem 0.45rem 0.35rem 0.65rem;
		gap: 0.25rem;
	}

	.page-title {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.82rem;
	}

	.page-actions {
		position: relative;
		display: flex;
		align-items: center;
	}

	.menu-toggle {
		opacity: 0.45;
		flex-direction: row;
		gap: 0.15rem;
	}

	.menu-toggle span {
		display: block;
		width: 3px;
		height: 3px;
		border-radius: 999px;
		background: var(--line-color);
	}

	.page-row:hover .menu-toggle,
	.page-row.active .menu-toggle {
		opacity: 1;
	}

	.menu-toggle[aria-expanded='true'] {
		opacity: 0;
		pointer-events: none;
	}

	.title-input {
		width: 100%;
		min-width: 0;
		border: 0;
		outline: none;
		background: transparent;
		font: inherit;
		color: inherit;
		padding: 0;
	}

	.confirm-title {
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.workspace {
		width: 100%;
		min-height: 100vh;
		background: var(--page-background);
	}

	@media (max-width: 767px) {
		.top-bar-shell {
			padding:
				max(0.6rem, env(safe-area-inset-top))
				max(0.6rem, env(safe-area-inset-right))
				0
				max(0.6rem, env(safe-area-inset-left));
		}

		.count-shell {
			padding:
				max(0.6rem, env(safe-area-inset-top))
				max(0.6rem, env(safe-area-inset-right))
				0
				max(0.6rem, env(safe-area-inset-left));
		}

		.count-toggle {
			max-width: calc(100vw - 5rem);
			padding-inline: 0.65rem;
			font-size: 0.72rem;
		}
	}
</style>
