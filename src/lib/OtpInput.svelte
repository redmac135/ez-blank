<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	const OTP_LENGTH = 8;
	const dispatch = createEventDispatcher<{
		change: { value: string };
		complete: { value: string };
	}>();

	export let value = '';
	export let disabled = false;
	export let shake = false;

	let inputs: Array<HTMLInputElement | null> = Array.from({ length: OTP_LENGTH }, () => null);

	$: digits = Array.from({ length: OTP_LENGTH }, (_, index) => value[index] ?? '');

	function handleInput(index: number, event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		const nextDigit = target.value.replace(/\D/g, '').slice(-1);
		const nextDigits = [...digits];
		nextDigits[index] = nextDigit;
		updateValue(nextDigits.join(''));

		if (nextDigit && index < OTP_LENGTH - 1) {
			inputs[index + 1]?.focus();
			inputs[index + 1]?.select();
		}
	}

	function handleKeydown(index: number, event: KeyboardEvent) {
		const target = event.currentTarget as HTMLInputElement;

		if (event.key === 'Backspace' && !target.value && index > 0) {
			event.preventDefault();
			const previous = inputs[index - 1];
			previous?.focus();
			previous?.select();
			return;
		}

		if (event.key === 'ArrowLeft' && index > 0) {
			event.preventDefault();
			inputs[index - 1]?.focus();
			inputs[index - 1]?.select();
		}

		if (event.key === 'ArrowRight' && index < OTP_LENGTH - 1) {
			event.preventDefault();
			inputs[index + 1]?.focus();
			inputs[index + 1]?.select();
		}
	}

	function handlePaste(event: ClipboardEvent) {
		event.preventDefault();
		const pasted =
			event.clipboardData?.getData('text')?.replace(/\D/g, '').slice(0, OTP_LENGTH) ?? '';
		if (!pasted) return;

		updateValue(pasted);

		const focusIndex = Math.min(pasted.length, OTP_LENGTH) - 1;
		inputs[Math.max(focusIndex, 0)]?.focus();
		inputs[Math.max(focusIndex, 0)]?.select();
	}

	function updateValue(nextValue: string) {
		value = nextValue;
		dispatch('change', { value: nextValue });

		if (nextValue.length === OTP_LENGTH) {
			dispatch('complete', { value: nextValue });
		}
	}
</script>

<div class:shake class="otp-input" on:paste={handlePaste}>
	{#each digits as digit, index (index)}
		<input
			bind:this={inputs[index]}
			id={`otp-digit-${index + 1}`}
			name={`otp-digit-${index + 1}`}
			type="text"
			inputmode="numeric"
			autocomplete="one-time-code"
			pattern="[0-9]*"
			maxlength="1"
			class="otp-digit"
			value={digit}
			{disabled}
			aria-label={`Digit ${index + 1}`}
			on:input={(event) => handleInput(index, event)}
			on:keydown={(event) => handleKeydown(index, event)}
		/>
	{/each}
</div>

<style>
	.otp-input {
		display: flex;
		flex-wrap: nowrap;
		justify-content: center;
		gap: 0.25rem;
		width: 100%;
		max-width: 100%;
		overflow-x: hidden;
	}

	.otp-digit {
		width: min(2.35rem, calc((100vw - 3.75rem) / 8));
		min-width: 0;
		flex: 0 1 auto;
		aspect-ratio: 1;
		border: 1px solid var(--surface-border-color);
		border-radius: 0.45rem;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 1.08rem;
		text-align: center;
		box-sizing: border-box;
	}

	.otp-digit:focus {
		outline: none;
		border-color: var(--text-color);
	}

	.otp-digit:disabled {
		opacity: 0.55;
	}

	.otp-input.shake {
		animation: otp-shake 260ms ease;
	}

	@keyframes otp-shake {
		0%,
		100% {
			transform: translateX(0);
		}

		20% {
			transform: translateX(-6px);
		}

		40% {
			transform: translateX(5px);
		}

		60% {
			transform: translateX(-4px);
		}

		80% {
			transform: translateX(3px);
		}
	}
</style>
