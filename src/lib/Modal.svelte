<script lang="ts">
	export let title: string;
	export let dismissible = true;
	export let onClose: () => void = () => {};

	const headingId = `modal-${Math.random().toString(36).slice(2, 10)}`;
</script>

{#if dismissible}
	<button class="modal-scrim" type="button" aria-label="Close dialog" on:click={onClose}></button>
{:else}
	<div class="modal-scrim" aria-hidden="true"></div>
{/if}

<div class="modal" role="dialog" aria-modal="true" aria-labelledby={headingId}>
	<h2 id={headingId}>{title}</h2>
	<div class="modal-body">
		<slot />
	</div>
	<div class="modal-actions">
		<slot name="actions" />
	</div>
</div>

<style>
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
		width: min(24rem, calc(100vw - 2rem));
		padding: 1rem;
		box-sizing: border-box;
		background: var(--surface-color);
		border: 1px solid var(--surface-border-color);
		border-radius: 0.55rem;
		box-shadow: 0 18px 50px var(--surface-shadow-color);
		transform: translate(-50%, -50%);
	}

	h2,
	.modal-body :global(p) {
		margin: 0;
	}

	h2 {
		font-size: 0.9rem;
		font-weight: 400;
	}

	.modal-body {
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
</style>
