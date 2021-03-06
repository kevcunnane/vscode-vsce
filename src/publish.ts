import * as fs from 'fs';
import { ExtensionQueryFlags, PublishedExtension, ExtensionQueryFilterType, PagingDirection, SortByType, SortOrderType } from 'vso-node-api/interfaces/GalleryInterfaces';
import { pack, readManifest, writeManifest, IPackageResult } from './package';
import * as tmp from 'tmp';
import { getPublisher } from './store';
import { getGalleryAPI, read } from './util';
import { validatePublisher } from './validation';
import { Manifest } from './manifest';
import * as denodeify from 'denodeify';
import * as yauzl from 'yauzl';
import * as semver from 'semver';

const tmpName = denodeify<string>(tmp.tmpName);

function readManifestFromPackage(packagePath: string): Promise<Manifest> {
	return new Promise<Manifest>((c, e) => {
		yauzl.open(packagePath, (err, zipfile) => {
			if (err) {
				return e(err);
			}

			const onEnd = () => e(new Error('Manifest not found'));
			zipfile.once('end', onEnd);

			zipfile.on('entry', entry => {
				if (!/^extension\/package\.json$/i.test(entry.fileName)) {
					return;
				}

				zipfile.removeListener('end', onEnd);

				zipfile.openReadStream(entry, (err, stream) => {
					if (err) {
						return e(err);
					}

					const buffers = [];
					stream.on('data', buffer => buffers.push(buffer));
					stream.once('error', e);
					stream.once('end', () => {
						try {
							c(JSON.parse(Buffer.concat(buffers).toString('utf8')));
						} catch (err) {
							e(err);
						}
					});
				});
			});
		});
	});
}

function _publish(packagePath: string, pat: string, manifest: Manifest): Promise<void> {
	const api = getGalleryAPI(pat);

	const packageStream = fs.createReadStream(packagePath);

	const fullName = `${manifest.publisher}.${manifest.name}@${manifest.version}`;
	console.log(`Publishing ${fullName}...`);

	return api.getExtension(manifest.publisher, manifest.name, null, ExtensionQueryFlags.IncludeVersions)
		.catch<PublishedExtension>(err => err.statusCode === 404 ? null : Promise.reject(err))
		.then(extension => {
			if (extension && extension.versions.some(v => v.version === manifest.version)) {
				return Promise.reject(`${fullName} already exists. Version number cannot be the same.`);
			}

			var promise = extension
				? api.updateExtension(undefined, packageStream, manifest.publisher, manifest.name)
				: api.createExtension(undefined, packageStream);

			return promise
				.catch(err => Promise.reject(err.statusCode === 409 ? `${fullName} already exists.` : err))
				.then(() => console.log(`Successfully published ${fullName}!`));
		})
		.catch(err => {
			const message = err && err.message || '';

			if (/Invalid Resource/.test(message)) {
				err.message = `${err.message}\n\nYou're likely using an expired Personal Access Token, please get a new PAT.\nMore info: https://aka.ms/vscodepat`;
			}

			return Promise.reject(err);
		});
}

export interface IPublishOptions {
	packagePath?: string;
	version?: string;
	cwd?: string;
	pat?: string;
	baseContentUrl?: string;
	baseImagesUrl?: string;
}

function versionBump(cwd: string = process.cwd(), version?: string): Promise<void> {
	if (!version) {
		return Promise.resolve(null);
	}

	return readManifest(cwd, false)
		.then(manifest => {
			switch (version) {
				case 'major':
				case 'minor':
				case 'patch':
					return { manifest, version: semver.inc(manifest.version, version) };
				default:
					const updatedVersion = semver.valid(version);

					if (!updatedVersion) {
						return Promise.reject(`Invalid version ${version}`);
					}

					return { manifest, version: updatedVersion };
			}
		}).then(({ manifest, version }) => {
			if (version !== manifest.version) {
				manifest.version = version;
				return writeManifest(cwd, manifest);
			}
		});
}

export function publish(options: IPublishOptions = {}): Promise<any> {
	let promise: Promise<IPackageResult>;

	if (options.packagePath) {
		if (options.version) {
			return Promise.reject(`Not supported: packagePath and version.`);
		}

		promise = readManifestFromPackage(options.packagePath)
			.then(manifest => ({ manifest, packagePath: options.packagePath }));
	} else {
		const cwd = options.cwd;
		const baseContentUrl = options.baseContentUrl;
		const baseImagesUrl = options.baseImagesUrl;

		promise = versionBump(options.cwd, options.version)
			.then(() => tmpName())
			.then(packagePath => pack({ packagePath, cwd, baseContentUrl, baseImagesUrl }));
	}

	return promise.then(({ manifest, packagePath }) => {
		if (manifest.enableProposedApi) {
			throw new Error('Extensions using proposed API (enableProposedApi: true) can\'t be published to the Marketplace');
		}

		const patPromise = options.pat
			? Promise.resolve(options.pat)
			: getPublisher(manifest.publisher).then(p => p.pat);

		return patPromise.then(pat => _publish(packagePath, pat, manifest));
	});
}

export function list(publisher: string): Promise<any> {
	validatePublisher(publisher);

	return getPublisher(publisher)
		.then(p => p.pat)
		.then(getGalleryAPI)
		.then(api => {
			const criteria = [{ filterType: ExtensionQueryFilterType.InstallationTarget, value: 'Microsoft.VisualStudio.Code' }];
			const filters = [{ criteria, direction: PagingDirection.Forward, pageNumber: 0, pageSize: 1000, pagingToken: null, sortBy: SortByType.Relevance, sortOrder: SortOrderType.Default }];
			const query = { filters, flags: ExtensionQueryFlags.IncludeLatestVersionOnly | ExtensionQueryFlags.IncludeVersionProperties, assetTypes: [] };

			return api.queryExtensions(query).then(result => {
				return result.results[0].extensions
					.filter(e => e.publisher.publisherName === publisher)
					.forEach(e => console.log(`${e.extensionName} @ ${e.versions[0].version}`));
			});
		});
}

export interface IUnpublishOptions extends IPublishOptions {
	id?: string;
}

export function unpublish(options: IUnpublishOptions = {}): Promise<any> {
	let promise: Promise<{ publisher: string; name: string; }>;

	if (options.id) {
		const [publisher, name] = options.id.split('.');
		promise = Promise.resolve(({ publisher, name }));
	} else {
		promise = readManifest(options.cwd);
	}

	return promise.then(({ publisher, name }) => {
		const fullName = `${publisher}.${name}`;
		const pat = options.pat
			? Promise.resolve(options.pat)
			: getPublisher(publisher).then(p => p.pat);

		return read(`This will FOREVER delete '${fullName}'! Are you sure? [y/N] `)
			.then(answer => /^y$/i.test(answer) ? null : Promise.reject('Aborted'))
			.then(() => pat)
			.then(getGalleryAPI)
			.then(api => api.deleteExtension(publisher, name))
			.then(() => console.log(`Successfully deleted ${fullName}!`));
	});
}
