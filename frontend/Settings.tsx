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
	const [devFire, setDevFire] = useState(settings().devFire);

	useEffect(() => {
		// The panel can be opened before the stored value has been read back.
		void loadSettings().then((s) => {
			setHide(s.hideSteamToast);
			setDevFire(s.devFire);
		});
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
			<ToggleField
				label="Accept test commands from tools/fire"
				description={
					'Developer aid: lets the tools/fire script in the plugin directory push ' +
					'synthesized test notifications through Steam’s own pipeline. Leave off ' +
					'unless you are working on the plugin.'
				}
				checked={devFire}
				onChange={(value: boolean) => {
					setDevFire(value);
					void updateSettings({ devFire: value });
				}}
			/>
		</DialogControlsSection>
	);
}
