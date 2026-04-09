<script lang="ts">
	export let label = 'Menu';
	export let verticalOffset = '0.2rem';
</script>

<div class="floating-menu" role="menu" aria-label={label} style={`top: calc(100% + ${verticalOffset})`}>
	<slot />
</div>

<style>
	.floating-menu {
		position: absolute;
		right: 0;
		z-index: 2;
		min-width: 8.5rem;
		padding: 0.25rem;
		background: var(--surface-color, #fff);
		border: 1px solid var(--surface-border-color, rgba(0, 0, 0, 0.08));
		border-radius: 0.45rem;
		box-shadow: 0 12px 30px var(--surface-shadow-color, rgba(0, 0, 0, 0.06));
		display: flex;
		flex-direction: column;
		font-size: 0.75rem;
		color: var(--text-color, #111);
	}

	.floating-menu :global(button) {
		padding: 0.55rem 0.65rem;
		text-align: left;
		border: 0;
		border-radius: 0.3rem;
		background: transparent;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.floating-menu :global(.menu-stat) {
		padding: 0.55rem 0.65rem;
		color: var(--muted-text-color, rgba(0, 0, 0, 0.72));
	}

	.floating-menu :global(button:hover) {
		background: var(--hover-background-color, rgba(0, 0, 0, 0.035));
	}
</style>
