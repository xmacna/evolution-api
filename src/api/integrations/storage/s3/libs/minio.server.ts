import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService, S3 } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import { join } from 'path';
import { Readable, Transform } from 'stream';

// xmacna/elysium#518 (2026-09-14): this module used to wrap the `minio` client. The only
// patched release of its transitive `stream-json` breaks minio at import, so the runtime
// audit gate could never go green. The wrapper now speaks to S3 through the same AWS SDK
// family the fork already ships (`@aws-sdk/client-sqs`), keeping the exported contract
// (`BUCKET`, `uploadFile`, `uploadTempFile`, `getObjectUrl`, `deleteFile`) byte-compatible
// for the six callers. The file keeps its historical name so no importer changes.

const logger = new Logger('S3 Service');

const BUCKET = new ConfigService().get<S3>('S3');

/** Minio accepted a flat header bag; `Content-Type` is a real header, the rest is object metadata. */
interface Metadata {
  'Content-Type': string;
  [key: string]: string;
}

/** minio's presignedGetObject default (7 days) — also the SigV4 maximum. */
export const DEFAULT_PRESIGN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export function buildS3ClientConfig(bucket: S3): S3ClientConfig {
  const scheme = bucket.USE_SSL ? 'https' : 'http';
  const defaultPort = bucket.USE_SSL ? 443 : 80;
  const host = bucket.PORT && bucket.PORT !== defaultPort ? `${bucket.ENDPOINT}:${bucket.PORT}` : bucket.ENDPOINT;
  return {
    region: bucket.REGION,
    endpoint: `${scheme}://${host}`,
    credentials: { accessKeyId: bucket.ACCESS_KEY, secretAccessKey: bucket.SECRET_KEY },
    // minio used virtual-host style only for amazonaws endpoints and path style elsewhere
    // (self-hosted MinIO). Same rule here.
    forcePathStyle: !/\.amazonaws\.com$/i.test(bucket.ENDPOINT || ''),
  };
}

function splitMetadata(metadata: Metadata): { contentType: string; custom: Record<string, string> } {
  const custom: Record<string, string> = {};
  let contentType = '';
  for (const [key, value] of Object.entries(metadata || {})) {
    if (key.toLowerCase() === 'content-type') contentType = String(value);
    else if (value !== undefined && value !== null) custom[key] = String(value);
  }
  return { contentType, custom };
}

type S3Sender = Pick<S3Client, 'send'>;

/**
 * Builds the storage backend over an injectable client (tests pass a fake `send`).
 * Every function is a no-op when the bucket is disabled, exactly like the minio wrapper.
 */
export function createS3Backend(bucket: S3, client: S3Sender | undefined) {
  const bucketName = bucket?.BUCKET_NAME;

  const bucketExists = async () => {
    if (client) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucketName }));
        return true;
      } catch {
        return false;
      }
    }
  };

  const setBucketPolicy = async () => {
    if (client) {
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${bucketName}/*`],
          },
        ],
      };
      await client.send(new PutBucketPolicyCommand({ Bucket: bucketName, Policy: JSON.stringify(policy) }));
    }
  };

  const createBucket = async () => {
    if (client) {
      try {
        const exists = await bucketExists();
        if (!exists) {
          await client.send(new CreateBucketCommand({ Bucket: bucketName }));
        }
        if (!bucket.SKIP_POLICY) {
          await setBucketPolicy();
        }
        logger.info(`S3 Bucket ${bucketName} - ON`);
        return true;
      } catch (error) {
        logger.error('S3 ERROR:');
        logger.error(error);
        return false;
      }
    }
  };

  const putObject = async (
    objectName: string,
    file: Buffer | Transform | Readable,
    size: number,
    metadata: Metadata,
  ) => {
    metadata['custom-header-application'] = 'evolution-api';
    const { contentType, custom } = splitMetadata(metadata);
    return client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectName,
        Body: file,
        ContentType: contentType || undefined,
        ContentLength: Number.isFinite(size) && size >= 0 ? size : undefined,
        Metadata: custom,
      }),
    );
  };

  const uploadFile = async (
    fileName: string,
    file: Buffer | Transform | Readable,
    size: number,
    metadata: Metadata,
  ) => {
    if (client) {
      const objectName = join('evolution-api', fileName);
      try {
        return await putObject(objectName, file, size, metadata);
      } catch (error) {
        logger.error(error);
        return error;
      }
    }
  };

  const getObjectUrl = async (fileName: string, expiry?: number) => {
    if (client) {
      try {
        const objectName = join('evolution-api', fileName);
        const expiresIn =
          expiry && expiry > 0 ? Math.min(expiry, DEFAULT_PRESIGN_EXPIRY_SECONDS) : DEFAULT_PRESIGN_EXPIRY_SECONDS;
        return await getSignedUrl(client as S3Client, new GetObjectCommand({ Bucket: bucketName, Key: objectName }), {
          expiresIn,
        });
      } catch (error) {
        throw new BadRequestException(error?.message);
      }
    }
  };

  const uploadTempFile = async (
    folder: string,
    fileName: string,
    file: Buffer | Transform | Readable,
    size: number,
    metadata: Metadata,
  ) => {
    if (client) {
      const objectName = join(folder, fileName);
      try {
        return await putObject(objectName, file, size, metadata);
      } catch (error) {
        logger.error(error);
        return error;
      }
    }
  };

  const deleteFile = async (folder: string, fileName: string) => {
    if (client) {
      const objectName = join(folder, fileName);
      try {
        return await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectName }));
      } catch (error) {
        logger.error(error);
        return error;
      }
    }
  };

  return { createBucket, uploadFile, uploadTempFile, getObjectUrl, deleteFile };
}

const s3Client = BUCKET?.ENABLE ? new S3Client(buildS3ClientConfig(BUCKET)) : undefined;

const backend = createS3Backend(BUCKET, s3Client);

backend.createBucket();

const { deleteFile, getObjectUrl, uploadFile, uploadTempFile } = backend;

export { BUCKET, deleteFile, getObjectUrl, uploadFile, uploadTempFile };
