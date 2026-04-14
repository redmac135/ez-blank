<script lang="ts">
	export let name: 'bars-3' | 'ellipsis-horizontal';
</script>

{#if name === 'bars-3'}
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path
			d="M3.75 5.25h16.5m-16.5 6h16.5m-16.5 6h16.5"
			fill="none"
			stroke="currentColor"
			stroke-linecap="round"
			stroke-width="1.5"
		></path>
	</svg>
{:else}
	<svg viewBox="0 0 20 20" aria-hidden="true">
		<path
			d="M6 10a2 2 0 11-4 0 2 2 0 014 0zm6 0a2 2 0 11-4 0 2 2 0 014 0zm6 0a2 2 0 11-4 0 2 2 0 014 0z"
		></path>
	</svg>
{/if}

<style>
	svg {
		display: block;
		width: 1rem;
		height: 1rem;
	}
</style>
