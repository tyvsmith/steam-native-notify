import { DialogControlsSection, ToggleField } from 'millennium';
import { loadSettings, settings, updateSettings } from './settings';

// window.SP_REACT is Steam's own React, typed by the millennium SDK as
// `typeof React`; JSX itself compiles through the automatic runtime, which the
// bundler maps onto Steam's JSX factory (window.SP_JSX_FACTORY).
export function SettingsPanel() {
	const { useState, useEffect } = window.SP_REACT;
	const [hide, setHide] = useState(settings().hideSteamToast);
	const [nativeInGame, setNativeInGame] = useState(settings().nativeToastInGame);
	const [devFire, setDevFire] = useState(settings().devFire);

	useEffect(() => {
		// The panel can be opened before the stored value has been read back.
		void loadSettings().then((s) => {
			setHide(s.hideSteamToast);
			setNativeInGame(s.nativeToastInGame);
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
				label="Keep Steam's own toasts while in a game"
				description={
					'While a game has focus, Steam shows its own in-game toast and no ' +
					'desktop notification is sent. With the game unfocused or closed, ' +
					'desktop notifications work as normal.'
				}
				checked={nativeInGame}
				onChange={(value: boolean) => {
					setNativeInGame(value);
					void updateSettings({ nativeToastInGame: value });
				}}
			/>
			<ToggleField
				label="Accept test commands from tools/fire"
				description={
					'Developer aid: lets the tools/fire script in the plugin repository push ' +
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
