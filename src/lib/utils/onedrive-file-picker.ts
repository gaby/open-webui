import { PublicClientApplication } from '@azure/msal-browser';
import type { PopupRequest } from '@azure/msal-browser';
import { v4 as uuidv4 } from 'uuid';

class OneDriveConfig {
	private static instance: OneDriveConfig;
	private clientId: string = '';
	private authorityType: 'personal' | 'organizations' = 'personal';
	private sharepointUrl: string = '';
	private msalInstance: PublicClientApplication | null = null;
	private currentAuthorityType: 'personal' | 'organizations' = 'personal';

	private constructor() {}

	public static getInstance(): OneDriveConfig {
		if (!OneDriveConfig.instance) {
			OneDriveConfig.instance = new OneDriveConfig();
		}
		return OneDriveConfig.instance;
	}

	public async initialize(authorityType?: 'personal' | 'organizations'): Promise<void> {
		if (authorityType && this.currentAuthorityType !== authorityType) {
			console.log('Authority type changed, resetting msalInstance');
			this.currentAuthorityType = authorityType;
			this.msalInstance = null;
		}
		await this.getCredentials();
	}

	public async ensureInitialized(authorityType?: 'personal' | 'organizations'): Promise<void> {
		await this.initialize(authorityType);
	}

	private async getCredentials(selectedAuthorityType?: 'personal' | 'organizations'): Promise<void> {
		let response;
		const headers: HeadersInit = {
			'Content-Type': 'application/json'
		};

		if(window.location.hostname === 'localhost') {
			response = await fetch('http://localhost:8080/api/config', { 
				headers,
				credentials: 'include'
			});
		} else {
			response = await fetch('/api/config', { 
				headers,
				credentials: 'include'
			});
		}
		
		if (!response.ok) {
			throw new Error('Failed to fetch OneDrive credentials');
		}
		
		const config = await response.json();
		
		const newClientId = config.onedrive?.client_id;
		const newSharepointUrl = config.onedrive?.sharepoint_url;
		
		if (!newClientId) {
			throw new Error('OneDrive configuration is incomplete');
		}
	
		this.clientId = newClientId;
		this.sharepointUrl = newSharepointUrl;
	}

	public async getMsalInstance(authorityType?: 'personal' | 'organizations'): Promise<PublicClientApplication> {
		await this.ensureInitialized(authorityType);
		
		if (!this.msalInstance) {
			const authorityEndpoint = this.currentAuthorityType === 'organizations' ? 'common' : 'consumers';
			const msalParams = {
				auth: {
					authority: `https://login.microsoftonline.com/${authorityEndpoint}`,
					clientId: this.clientId
				}
			};

			this.msalInstance = new PublicClientApplication(msalParams);
			if (this.msalInstance.initialize) {
				await this.msalInstance.initialize();
			}
		}

		return this.msalInstance;
	}

	public getAuthorityType(): 'personal' | 'organizations' {
		return this.currentAuthorityType;
	}

	public getSharepointUrl(): string {
		return this.sharepointUrl;
	}

	public getBaseUrl(): string {
		if (this.currentAuthorityType === 'organizations') {
			if (!this.sharepointUrl || this.sharepointUrl === '') {
				throw new Error('Sharepoint URL not configured');
			}

			let sharePointBaseUrl = this.sharepointUrl.replace(/^https?:\/\//, '');
			sharePointBaseUrl = sharePointBaseUrl.replace(/\/$/, '');

			return `https://${sharePointBaseUrl}`;
		} else {
			return 'https://onedrive.live.com/picker';
		}
	}
}


// Retrieve OneDrive access token
async function getToken(resource?: string, authorityType?: 'personal' | 'organizations'): Promise<string> {
	const config = OneDriveConfig.getInstance();
	await config.ensureInitialized(authorityType);
	
	const currentAuthorityType = config.getAuthorityType();

	const scopes = currentAuthorityType === 'organizations'
		? [`${resource || config.getBaseUrl()}/.default`]
		: ['OneDrive.ReadWrite'];

	console.log('scopes', scopes);
	
	const authParams: PopupRequest = { scopes };
	let accessToken = '';

	try {
		const msalInstance = await config.getMsalInstance(authorityType);
		const resp = await msalInstance.acquireTokenSilent(authParams);
		accessToken = resp.accessToken;
	} catch (err) {
		const msalInstance = await config.getMsalInstance(authorityType);
		try {
			const resp = await msalInstance.loginPopup(authParams);
			msalInstance.setActiveAccount(resp.account);
			if (resp.idToken) {
				const resp2 = await msalInstance.acquireTokenSilent(authParams);
				accessToken = resp2.accessToken;
			}
		} catch (popupError) {
			throw new Error(
				'Failed to login: ' +
					(popupError instanceof Error ? popupError.message : String(popupError))
			);
		}
	}

	if (!accessToken) {
		throw new Error('Failed to acquire access token');
	}

	return accessToken;
}

// Get picker parameters based on account type
function getPickerParams(): {
	sdk: string;
	entry: {
		oneDrive: Record<string, unknown>;
	};
	authentication: Record<string, unknown>;
	messaging: {
		origin: string;
		channelId: string;
	};
	typesAndSources: {
		mode: string;
		pivots: Record<string, boolean>;
	};
} {
	const channelId = uuidv4();
	
	if (OneDriveConfig.getInstance().getAuthorityType() === 'organizations') {
		// Parameters for OneDrive for Business
		return {
			sdk: '8.0',
			entry: {
				oneDrive: {}
			},
			authentication: {},
			messaging: {
				origin: window?.location?.origin || '',
				channelId
			},
			typesAndSources: {
				mode: 'files',
				pivots: {
					oneDrive: true,
					recent: true
				}
			}
		};
	} else {
		// Parameters for personal OneDrive
		return {
			sdk: '8.0',
			entry: {
				oneDrive: {
					files: {}
				}
			},
			authentication: {},
			messaging: {
				origin: window?.location?.origin || '',
				channelId
			},
			typesAndSources: {
				mode: 'files',
				pivots: {
					oneDrive: true,
					recent: true
				}
			}
		};
	}
}

// Download file from OneDrive
async function downloadOneDriveFile(fileInfo: Record<string, any>, authorityType?: 'personal' | 'organizations'): Promise<Blob> {
	const accessToken = await getToken(undefined, authorityType);
	if (!accessToken) {
		throw new Error('Unable to retrieve OneDrive access token.');
	}
	
	// The endpoint URL is provided in the file info
	const fileInfoUrl = `${fileInfo['@sharePoint.endpoint']}/drives/${fileInfo.parentReference.driveId}/items/${fileInfo.id}`;
	
	const response = await fetch(fileInfoUrl, {
		headers: {
			Authorization: `Bearer ${accessToken}`
		}
	});
	
	if (!response.ok) {
		throw new Error('Failed to fetch file information.');
	}
	
	const fileData = await response.json();
	const downloadUrl = fileData['@content.downloadUrl'];
	const downloadResponse = await fetch(downloadUrl);
	
	if (!downloadResponse.ok) {
		throw new Error('Failed to download file.');
	}
	
	return await downloadResponse.blob();
}

interface PickerResult {
	items?: Array<{
		id: string;
		name: string;
		parentReference: {
			driveId: string;
		};
		'@sharePoint.endpoint': string;
		[key: string]: any;
	}>;
	command?: string;
	[key: string]: any;
}

// Open OneDrive file picker and return selected file metadata
export async function openOneDrivePicker(): Promise<PickerResult | null> {
	if (typeof window === 'undefined') {
		throw new Error('Not in browser environment');
	}

	// Force reinitialization of OneDrive config
	const config = OneDriveConfig.getInstance();
	await config.initialize();
	
	return new Promise((resolve, reject) => {
		let pickerWindow: Window | null = null;
		let channelPort: MessagePort | null = null;
		const params = getPickerParams();
		const baseUrl = config.getBaseUrl();

		const handleWindowMessage = (event: MessageEvent) => {
			if (event.source !== pickerWindow) return;
			const message = event.data;
			if (message?.type === 'initialize' && message?.channelId === params.messaging.channelId) {
				channelPort = event.ports?.[0];
				if (!channelPort) return;
				channelPort.addEventListener('message', handlePortMessage);
				channelPort.start();
				channelPort.postMessage({ type: 'activate' });
			}
		};

		const handlePortMessage = async (portEvent: MessageEvent) => {
			const portData = portEvent.data;
			switch (portData.type) {
				case 'notification':
					break;
				case 'command': {
					channelPort?.postMessage({ type: 'acknowledge', id: portData.id });
					const command = portData.data;
					switch (command.command) {
						case 'authenticate': {
							try {
								// Pass the resource from the command for org accounts
								const resource = OneDriveConfig.getInstance().getAuthorityType() === 'organizations' ? command.resource : undefined;
								const newToken = await getToken(resource);
								if (newToken) {
									channelPort?.postMessage({
										type: 'result',
										id: portData.id,
										data: { result: 'token', token: newToken }
									});
								} else {
									throw new Error('Could not retrieve auth token');
								}
							} catch (err) {
								channelPort?.postMessage({
									type: 'result',
									id: portData.id,
									data: {
										result: 'error',
										error: { code: 'tokenError', message: 'Failed to get token' }
									}
								});
							}
							break;
						}
						case 'close': {
							cleanup();
							resolve(null);
							break;
						}
						case 'pick': {
							channelPort?.postMessage({
								type: 'result',
								id: portData.id,
								data: { result: 'success' }
							});
							cleanup();
							resolve(command);
							break;
						}
						default: {
							channelPort?.postMessage({
								result: 'error',
								error: { code: 'unsupportedCommand', message: command.command },
								isExpected: true
							});
							break;
						}
					}
					break;
				}
			}
		};

		function cleanup() {
			window.removeEventListener('message', handleWindowMessage);
			if (channelPort) {
				channelPort.removeEventListener('message', handlePortMessage);
			}
			if (pickerWindow) {
				pickerWindow.close();
				pickerWindow = null;
			}
		}

		const initializePicker = async () => {
			try {
				const authToken = await getToken();
				if (!authToken) {
					return reject(new Error('Failed to acquire access token'));
				}

				pickerWindow = window.open('', 'OneDrivePicker', 'width=800,height=600');
				if (!pickerWindow) {
					return reject(new Error('Failed to open OneDrive picker window'));
				}

				const queryString = new URLSearchParams({
					filePicker: JSON.stringify(params)
				});

				let url = '';
				if(OneDriveConfig.getInstance().getAuthorityType() === 'organizations') {
					url = baseUrl + `/_layouts/15/FilePicker.aspx?${queryString}`;
				}else{
					url = baseUrl + `?${queryString}`;
				}
			

				const form = pickerWindow.document.createElement('form');
				form.setAttribute('action', url);
				form.setAttribute('method', 'POST');
				const input = pickerWindow.document.createElement('input');
				input.setAttribute('type', 'hidden');
				input.setAttribute('name', 'access_token');
				input.setAttribute('value', authToken);
				form.appendChild(input);

				pickerWindow.document.body.appendChild(form);
				form.submit();

				window.addEventListener('message', handleWindowMessage);
			} catch (err) {
				if (pickerWindow) {
					pickerWindow.close();
				}
				reject(err);
			}
		};

		initializePicker();
	});
}

// Pick and download file from OneDrive
export async function pickAndDownloadFile(authorityType?: 'personal' | 'organizations'): Promise<{ blob: Blob; name: string } | null> {
	// Force reinitialization with selected authority type
	const config = OneDriveConfig.getInstance();
	await config.initialize(authorityType);
	
	const pickerResult = await openOneDrivePicker();

	if (!pickerResult || !pickerResult.items || pickerResult.items.length === 0) {
		return null;
	}

	const selectedFile = pickerResult.items[0];
	const blob = await downloadOneDriveFile(selectedFile, authorityType);

	return { blob, name: selectedFile.name };
}

export { downloadOneDriveFile };