<script lang="ts">
	import { onMount } from 'svelte';
	// @ts-expect-error injected by @vite-pwa/sveltekit at build time
	import { useRegisterSW } from 'virtual:pwa-register/svelte';

	let { children } = $props();

	onMount(() => {
		useRegisterSW();
	});
</script>

{@render children()}
