import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { uploadObject, withNetworkRetry } from "./build.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "x" };
const networkError = (code: string) => Object.assign(new Error(code), { code });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("withNetworkRetry", () => {
  it("retries network errors, then gives up", async () => {
    const send = vi.fn().mockRejectedValue(networkError("ENOTFOUND"));
    await expect(withNetworkRetry(send, [1, 1])).rejects.toThrow("ENOTFOUND");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("never retries an AWS rejection", async () => {
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied" });
    const send = vi.fn().mockRejectedValue(denied);
    await expect(withNetworkRetry(send, [1, 1])).rejects.toThrow("denied");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("uploadObject", () => {
  it("sends a large source in 8 MB parts and retries only the part that dropped", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let dropped = false;
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) {
        sent.push("create");
        return { UploadId: "u1" };
      }
      if (command instanceof UploadPartCommand) {
        const { PartNumber, Body } = command.input;
        sent.push(`part ${PartNumber} (${(Body as Buffer).length} bytes)`);
        if (PartNumber === 2 && !dropped) {
          dropped = true;
          throw networkError("ECONNRESET");
        }
        return { ETag: `etag-${PartNumber}` };
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        sent.push(`complete ${JSON.stringify(command.input.MultipartUpload?.Parts)}`);
        return {};
      }
      throw new Error("unexpected command");
    });

    const body = Buffer.alloc(20 * 1024 * 1024);
    const upload = uploadObject(creds, "ap-south-1", "bucket", "source/latest.zip", body);
    await vi.runAllTimersAsync();
    await upload;

    const mb8 = 8 * 1024 * 1024;
    expect(sent).toEqual([
      "create",
      `part 1 (${mb8} bytes)`,
      `part 2 (${mb8} bytes)`,
      `part 2 (${mb8} bytes)`,
      `part 3 (${4 * 1024 * 1024} bytes)`,
      `complete ${JSON.stringify([1, 2, 3].map((n) => ({ ETag: `etag-${n}`, PartNumber: n })))}`,
    ]);
  });

  it("puts a small source in one request", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
    await uploadObject(creds, "ap-south-1", "bucket", "k", Buffer.from("x"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(PutObjectCommand);
  });
});
