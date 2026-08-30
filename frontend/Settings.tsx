import { DialogControlsSection, ToggleField, usePluginConfig } from 'millennium';
import { DEFAULTS, type Settings } from './settings';

/**
 * Every toggle is one usePluginConfig hook: the store is the state, writes go
 * straight to Millennium's config (pushed to the backend and the settings()
 * snapshot automatically), and a key never written yet reads as undefined --
 * the DEFAULTS merge here is what a fresh install sees.
 */
function useToggle(key: keyof Settings): [boolean, (value: boolean) => void] {
	const [value, setValue] = usePluginConfig<boolean>(key);
	return [typeof value === 'boolean' ? value : DEFAULTS[key], (next) => void setValue(next)];
}

export function SettingsPanel() {
	const [notifyOutsideGame, setNotifyOutsideGame] = useToggle('notifyOutsideGame');
	const [notifyInGame, setNotifyInGame] = useToggle('notifyInGame');
	const [hideSteamToast, setHideSteamToast] = useToggle('hideSteamToast');
	const [devFire, setDevFire] = useToggle('devFire');
	const [devMode] = useToggle('devMode');

	return (
		<DialogControlsSection>
			<ToggleField
				label="Use native notifications when outside of games"
				description={
					'Send Steam notifications to your desktop notification daemon while no ' +
					'game has focus. Clicking one does what clicking the Steam toast would.'
				}
				checked={notifyOutsideGame}
				onChange={setNotifyOutsideGame}
			/>
			<ToggleField
				label="Use native notifications when inside games"
				description={
					'Also send them to the desktop while a game has focus, alongside ' +
					'Steam’s in-game toast. Turn off to keep in-game notifications ' +
					'inside Steam only.'
				}
				checked={notifyInGame}
				onChange={setNotifyInGame}
			/>
			{/* The development surface. devMode has no toggle of its own -- it is
			    set out-of-band (tools/mep or the Millennium config file), so a
			    normal install never shows these. */}
			{devMode && (
				<ToggleField
					label="Developer: hide Steam's own toasts"
					description={
						'Closes Steam’s popup once its text has been read, leaving only ' +
						'the desktop notification.'
					}
					checked={hideSteamToast}
					onChange={setHideSteamToast}
				/>
			)}
			{devMode && (
				<ToggleField
					label="Developer: accept test commands from tools/fire"
					description={
						'Lets the tools/fire script in the plugin repository push synthesized ' +
						'test notifications through Steam’s own pipeline.'
					}
					checked={devFire}
					onChange={setDevFire}
				/>
			)}
		</DialogControlsSection>
	);
}
