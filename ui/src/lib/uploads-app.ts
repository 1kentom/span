/** The app's uploads store instances. Desktop only; the browser preview gets the honest unavailable api and no recorder. */
import * as client from './client';
import { createBindingsUploadsApi, createUnavailableUploadsApi, createUploadRecorder, type UploadRecorder } from './uploads-desktop';
import type { UploadsApi } from './uploads-api';

export const uploadsApi: UploadsApi = client.isDesktop ? createBindingsUploadsApi(client) : createUnavailableUploadsApi();
export const uploadRecorder: UploadRecorder | undefined = client.isDesktop ? createUploadRecorder(client) : undefined;
