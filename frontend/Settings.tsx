import { DialogControlsSection, ToggleField } from '@steambrew/client';
import { loadSettings, settings, updateSettings } from './settings';

declare global {
	interface Window {
		SP_REACT: {
			useState: <T>(initial: T | (() => T)) => [T, (value: T | ((prev: T) => T)) => void];
			useEffect: (cb: () => void | (() => void), deps?: unknown[]) => void;
			createElement: unknown;
			Fragment: unknown;
		};
	}
	// JSX compiles through window.SP_REACT.createElement, so host elements need
	// this stub to satisfy the type checker.
	namespace JSX {
		interface IntrinsicElements {
			[elem: string]: any;
		}
	}
}

export function SettingsPanel() {
	const { useState, useEffect } = window.SP_REACT;
	const [hide, setHide] = useState(settings().hideSteamToast);

	useEffect(() => {
		// The panel can be opened before the stored value has been read back.
		void loadSettings().then((s) => setHide(s.hideSteamToast));
	}, []);

	return (
		<DialogControlsSection>
			<ToggleField
				label="Hide Steam's own notification toasts"
				description={
					'Closes Steam’s popup once its text has been read, leaving only the ' +
					'desktop notification. Turn this off to see both side by side, which is ' +
					'useful for checking that a click behaves the same way.'
				}
				checked={hide}
				onChange={(value: boolean) => {
					setHide(value);
					void updateSettings({ hideSteamToast: value });
				}}
			/>
		</DialogControlsSection>
	);
}
