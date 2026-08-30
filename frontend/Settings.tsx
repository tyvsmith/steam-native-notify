import { DialogControlsSection, ToggleField } from 'millennium';
import { loadSettings, settings, updateSettings, type Settings } from './settings';

// window.SP_REACT is Steam's own React, typed by the millennium SDK as
// `typeof React`; JSX itself compiles through the automatic runtime, which the
// bundler maps onto Steam's JSX factory (window.SP_JSX_FACTORY).
export function SettingsPanel() {
	const { useState, useEffect } = window.SP_REACT;
	const [s, setS] = useState<Settings>(settings());

	useEffect(() => {
		// The panel can be opened before the stored value has been read back.
		void loadSettings().then((loaded) => setS({ ...loaded }));
	}, []);

	const toggle = (key: keyof Settings) => (value: boolean) => {
		setS({ ...s, [key]: value });
		void updateSettings({ [key]: value });
	};

	return (
		<DialogControlsSection>
			<ToggleField
				label="Use native notifications when outside of games"
				description={
					'Send Steam notifications to your desktop notification daemon while no ' +
					'game has focus. Clicking one does what clicking the Steam toast would.'
				}
				checked={s.notifyOutsideGame}
				onChange={toggle('notifyOutsideGame')}
			/>
			<ToggleField
				label="Use native notifications when inside games"
				description={
					'Also send them to the desktop while a game has focus, alongside ' +
					'Steam’s in-game toast. Turn off to keep in-game notifications ' +
					'inside Steam only.'
				}
				checked={s.notifyInGame}
				onChange={toggle('notifyInGame')}
			/>
			{/* The development surface. devMode has no toggle of its own -- it is
			    set out-of-band (tools/mep or the Millennium config file), so a
			    normal install never shows these. */}
			{s.devMode && (
				<ToggleField
					label="Developer: hide Steam's own toasts"
					description={
						'Closes Steam’s popup once its text has been read, leaving only ' +
						'the desktop notification.'
					}
					checked={s.hideSteamToast}
					onChange={toggle('hideSteamToast')}
				/>
			)}
			{s.devMode && (
				<ToggleField
					label="Developer: accept test commands from tools/fire"
					description={
						'Lets the tools/fire script in the plugin repository push synthesized ' +
						'test notifications through Steam’s own pipeline.'
					}
					checked={s.devFire}
					onChange={toggle('devFire')}
				/>
			)}
		</DialogControlsSection>
	);
}
