<script lang="ts">
	import { onMount } from 'svelte';
	// @ts-expect-error injected by @vite-pwa/sveltekit at build time
	import { useRegisterSW } from 'virtual:pwa-register/svelte';

	let { children } = $props();

	onMount(() => {
		const hadController = typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;

		useRegisterSW({
			onRegisteredSW(_swUrl: string, registration: ServiceWorkerRegistration | undefined) {
				if (!registration?.active) {
					return;
				}

				navigator.serviceWorker.addEventListener('controllerchange', () => {
					if (!hadController) {
						return;
					}

					try {
						localStorage.setItem('blank-app-updated-notice', 'App updated');
					} catch (error) {
						void error;
					}
				});
			}
		});
	});
</script>

{@render children()}
