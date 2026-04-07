<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Editor from '$lib/Editor.svelte';
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

	$: activePage = getActivePage(session);

	function getActivePage(currentSession: EditorSession): EditorPage {
		return (
			currentSession.pages.find((page) => page.id === currentSession.activePageId) ??
			currentSession.pages[0] ??
			createPage()
		);
	}

	function persistSession(nextSession: EditorSession) {
		session = nextSession;
		if (loaded) {
			EditorStorage.save(nextSession);
		}
	}

	function updateActivePage(state: EditorState) {
		persistSession({
			...session,
			pages: session.pages.map((page) =>
				page.id === session.activePageId ? updatePageState(page, state) : page
			)
		});
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
		if (
			event.key !== EditorStorage.STORAGE_KEY &&
			event.key !== EditorStorage.LEGACY_STORAGE_KEY
		) {
			return;
		}

		session = EditorStorage.load();
	}

	onMount(() => {
		session = EditorStorage.load();
		loaded = true;
	});

	$: deletePage = deletePageId
		? session.pages.find((page) => page.id === deletePageId) ?? null
		: null;
</script>

<svelte:window on:beforeunload={() => EditorStorage.save(session)} on:storage={handleStorage} />

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
						<div class="page-menu">
							<button type="button" on:click={() => startEditingTitle(page.id)}>Edit title</button>
							<button type="button" on:click={() => openDeleteModal(page.id)}>Delete</button>
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</nav>
</aside>

<section class="workspace">
	{#key activePage.id}
		<Editor
			initialState={{
				text: activePage.content,
				selectionStart: activePage.selectionStart,
				selectionEnd: activePage.selectionEnd
			}}
			onChange={updateActivePage}
		/>
	{/key}
</section>

<style>
	:global(body) {
		margin: 0;
		background: #fff;
		color: #111;
		font-family: 'Roboto Mono', monospace;
	}

	.drawer-toggle {
		position: fixed;
		top: 1.2rem;
		left: 1.2rem;
		z-index: 20;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: 0;
		background: transparent;
		display: inline-flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.28rem;
		cursor: pointer;
	}

	.drawer-toggle span {
		display: block;
		width: 1rem;
		height: 1px;
		background: #111;
	}

	.scrim {
		position: fixed;
		inset: 0;
		z-index: 10;
		border: 0;
		background: rgba(255, 255, 255, 0.72);
	}

	.modal-scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
		border: 0;
		background: rgba(255, 255, 255, 0.8);
	}

	.modal {
		position: fixed;
		top: 50%;
		left: 50%;
		z-index: 31;
		width: min(22rem, calc(100vw - 2rem));
		padding: 1rem;
		box-sizing: border-box;
		background: #fff;
		border: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 0.55rem;
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.08);
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
		color: rgba(0, 0, 0, 0.65);
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
		background: rgba(0, 0, 0, 0.035);
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
		z-index: 15;
		width: min(18rem, 82vw);
		padding: 4.25rem 1rem 1rem;
		box-sizing: border-box;
		background: #fff;
		border-right: 1px solid rgba(0, 0, 0, 0.08);
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
	.page-menu button,
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
		background: rgba(0, 0, 0, 0.035);
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
		background: #111;
	}

	.page-row:hover .menu-toggle,
	.page-row.active .menu-toggle {
		opacity: 1;
	}

	.menu-toggle[aria-expanded='true'] {
		opacity: 0;
		pointer-events: none;
	}

	.page-menu {
		position: absolute;
		top: calc(100% + 0.2rem);
		right: 0;
		z-index: 2;
		min-width: 8.5rem;
		padding: 0.25rem;
		background: #fff;
		border: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 0.45rem;
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.06);
		display: flex;
		flex-direction: column;
	}

	.page-menu button {
		padding: 0.55rem 0.65rem;
		text-align: left;
		border-radius: 0.3rem;
	}

	.page-menu button:hover {
		background: rgba(0, 0, 0, 0.035);
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
		background: #fff;
	}
</style>
