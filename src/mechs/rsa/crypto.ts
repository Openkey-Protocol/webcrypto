import crypto from "crypto";
import { AsnParser, AsnSerializer } from "@peculiar/asn1-schema";
import { JsonParser, JsonSerializer } from "@peculiar/json-schema";
import * as core from "webcrypto-core";
import { RsaPrivateKey } from "./private_key";
import { RsaPublicKey } from "./public_key";
import { CryptoKey } from "../../keys";

interface INodeCryptoSignOptions {
  key: string;
  passphrase?: string;
  padding?: number;
  saltLength?: number;
}

export class RsaCrypto {

  public static publicKeyUsages = ["verify", "encrypt", "wrapKey"];
  public static privateKeyUsages = ["sign", "decrypt", "unwrapKey"];

  public static async generateKey(algorithm: RsaHashedKeyGenParams | RsaKeyGenParams, extractable: boolean, keyUsages: string[]): Promise<CryptoKeyPair> {
    const privateKey = new RsaPrivateKey();
    privateKey.algorithm = algorithm as RsaHashedKeyAlgorithm;
    privateKey.extractable = extractable;
    privateKey.usages = keyUsages.filter((usage) => this.privateKeyUsages.indexOf(usage) !== -1) as KeyUsage[];

    const publicKey = new RsaPublicKey();
    publicKey.algorithm = algorithm as RsaHashedKeyAlgorithm;
    publicKey.extractable = true;
    publicKey.usages = keyUsages.filter((usage) => this.publicKeyUsages.indexOf(usage) !== -1) as KeyUsage[];

    const publicExponent = Buffer.concat([
      Buffer.alloc(4 - algorithm.publicExponent.byteLength, 0),
      Buffer.from(algorithm.publicExponent),
    ]).readInt32BE(0);

    const keys = crypto.generateKeyPairSync("rsa", {
      modulusLength: algorithm.modulusLength,
      publicExponent,
      publicKeyEncoding: {
        format: "der",
        type: "spki",
      },
      privateKeyEncoding: {
        format: "der",
        type: "pkcs8",
      },
    });

    privateKey.data = keys.privateKey;
    publicKey.data = keys.publicKey;

    const res = {
      privateKey,
      publicKey,
    };

    return res;
  }

  public static async exportKey(format: KeyFormat, key: CryptoKey): Promise<JsonWebKey | ArrayBuffer> {
    switch (format.toLowerCase()) {
      case "jwk":
        return JsonSerializer.toJSON(key);
      case "pkcs8":
      case "spki":
        return new Uint8Array(key.data).buffer;
      default:
        throw new core.OperationError("format: Must be 'jwk', 'pkcs8' or 'spki'");
    }
  }

  public static async importKey(format: KeyFormat, keyData: JsonWebKey | ArrayBuffer, algorithm: RsaHashedImportParams, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey> {
    switch (format.toLowerCase()) {
      case "jwk": {
        const jwk = keyData as JsonWebKey;
        if (jwk.d) {
          const asnKey = JsonParser.fromJSON(keyData, { targetSchema: core.asn1.RsaPrivateKey });
          return this.importPrivateKey(asnKey, algorithm, extractable, keyUsages);
        } else {
          const asnKey = JsonParser.fromJSON(keyData, { targetSchema: core.asn1.RsaPublicKey });
          return this.importPublicKey(asnKey, algorithm, extractable, keyUsages);
        }
      }
      case "spki": {
        const keyInfo = AsnParser.parse(new Uint8Array(keyData as ArrayBuffer), core.asn1.PublicKeyInfo);
        const asnKey = AsnParser.parse(keyInfo.publicKey, core.asn1.RsaPublicKey);
        return this.importPublicKey(asnKey, algorithm, extractable, keyUsages);
      }
      case "pkcs8": {
        const keyInfo = AsnParser.parse(new Uint8Array(keyData as ArrayBuffer), core.asn1.PrivateKeyInfo);
        const asnKey = AsnParser.parse(keyInfo.privateKey, core.asn1.RsaPrivateKey);
        return this.importPrivateKey(asnKey, algorithm, extractable, keyUsages);
      }
      default:
        throw new core.OperationError("format: Must be 'jwk', 'pkcs8' or 'spki'");
    }
  }

  public static async sign(algorithm: Algorithm, key: RsaPrivateKey, data: Uint8Array): Promise<ArrayBuffer> {
    switch (algorithm.name.toUpperCase()) {
      case "RSA-PSS":
      case "RSASSA-PKCS1-V1_5":
        return this.signRsa(algorithm, key, data);
      default:
        throw new core.OperationError("algorithm: Is not recognized");
    }
  }

  public static async verify(algorithm: Algorithm, key: RsaPublicKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    switch (algorithm.name.toUpperCase()) {
      case "RSA-PSS":
      case "RSASSA-PKCS1-V1_5":
        return this.verifySSA(algorithm, key, data, signature);
      default:
        throw new core.OperationError("algorithm: Is not recognized");
    }
  }

  public static async encrypt(algorithm: RsaOaepParams, key: RsaPublicKey, data: Uint8Array): Promise<ArrayBuffer> {
    switch (algorithm.name.toUpperCase()) {
      case "RSA-OAEP":
        return this.encryptOAEP(algorithm, key, data);
      default:
        throw new core.OperationError("algorithm: Is not recognized");
    }
  }

  public static async decrypt(algorithm: RsaOaepParams, key: RsaPrivateKey, data: Uint8Array): Promise<ArrayBuffer> {
    switch (algorithm.name.toUpperCase()) {
      case "RSA-OAEP":
        return this.decryptOAEP(algorithm, key, data);
      default:
        throw new core.OperationError("algorithm: Is not recognized");
    }
  }

  protected static importPrivateKey(asnKey: core.asn1.RsaPrivateKey, algorithm: RsaHashedImportParams, extractable: boolean, keyUsages: KeyUsage[]) {
    const keyInfo = new core.asn1.PrivateKeyInfo();
    keyInfo.privateKeyAlgorithm.algorithm = "1.2.840.113549.1.1.1";
    keyInfo.privateKeyAlgorithm.parameters = null;
    keyInfo.privateKey = AsnSerializer.serialize(asnKey);

    const key = new RsaPrivateKey();
    key.data = Buffer.from(AsnSerializer.serialize(keyInfo));

    key.algorithm = Object.assign({}, algorithm) as RsaHashedKeyAlgorithm;
    key.algorithm.publicExponent = new Uint8Array(asnKey.publicExponent);
    key.algorithm.modulusLength = asnKey.modulus.byteLength << 3;
    key.extractable = extractable;
    key.usages = keyUsages;

    return key;
  }

  protected static importPublicKey(asnKey: core.asn1.RsaPublicKey, algorithm: RsaHashedImportParams, extractable: boolean, keyUsages: KeyUsage[]) {
    const keyInfo = new core.asn1.PublicKeyInfo();
    keyInfo.publicKeyAlgorithm.algorithm = "1.2.840.113549.1.1.1";
    keyInfo.publicKeyAlgorithm.parameters = null;
    keyInfo.publicKey = AsnSerializer.serialize(asnKey);

    const key = new RsaPublicKey();
    key.data = Buffer.from(AsnSerializer.serialize(keyInfo));

    key.algorithm = Object.assign({}, algorithm) as RsaHashedKeyAlgorithm;
    key.algorithm.publicExponent = new Uint8Array(asnKey.publicExponent);
    key.algorithm.modulusLength = asnKey.modulus.byteLength << 3;
    key.extractable = extractable;
    key.usages = keyUsages;

    return key;
  }

  protected static getCryptoAlgorithm(alg: RsaHashedKeyAlgorithm) {
    switch (alg.hash.name.toUpperCase()) {
      case "SHA-1":
        return "RSA-SHA1";
      case "SHA-256":
        return "RSA-SHA256";
      case "SHA-384":
        return "RSA-SHA384";
      case "SHA-512":
        return "RSA-SHA512";
      case "SHA3-256":
        return "RSA-SHA3-256";
      case "SHA3-384":
        return "RSA-SHA3-384";
      case "SHA3-512":
        return "RSA-SHA3-512";
      default:
        throw new core.OperationError("algorithm.hash: Is not recognized");
    }
  }

  protected static signRsa(algorithm: Algorithm, key: RsaPrivateKey, data: Uint8Array) {
    const cryptoAlg = this.getCryptoAlgorithm(key.algorithm);
    const signer = crypto.createSign(cryptoAlg);
    signer.update(Buffer.from(data));

    if (!key.pem) {
      key.pem = `-----BEGIN PRIVATE KEY-----\n${key.data.toString("base64")}\n-----END PRIVATE KEY-----`;
    }
    const options: INodeCryptoSignOptions = {
      key: key.pem,
    };
    if (algorithm.name.toUpperCase() === "RSA-PSS") {
      options.padding = crypto.constants.RSA_PKCS1_PSS_PADDING;
      options.saltLength = (algorithm as RsaPssParams).saltLength;
    }

    const signature = signer.sign(options);
    return new Uint8Array(signature).buffer;
  }

  protected static verifySSA(algorithm: Algorithm, key: RsaPublicKey, data: Uint8Array, signature: Uint8Array) {
    const cryptoAlg = this.getCryptoAlgorithm(key.algorithm);
    const signer = crypto.createVerify(cryptoAlg);
    signer.update(Buffer.from(data));

    if (!key.pem) {
      key.pem = `-----BEGIN PUBLIC KEY-----\n${key.data.toString("base64")}\n-----END PUBLIC KEY-----`;
    }
    const options: INodeCryptoSignOptions = {
      key: key.pem,
    };
    if (algorithm.name.toUpperCase() === "RSA-PSS") {
      options.padding = crypto.constants.RSA_PKCS1_PSS_PADDING;
      options.saltLength = (algorithm as RsaPssParams).saltLength;
    }

    const ok = signer.verify(options, signature);
    return ok;
  }

  protected static encryptOAEP(algorithm: RsaOaepParams, key: RsaPublicKey, data: Uint8Array) {
    const options: crypto.RsaPublicKey = {
      key: `-----BEGIN PUBLIC KEY-----\n${key.data.toString("base64")}\n-----END PUBLIC KEY-----`,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    };
    if (algorithm.label) {
      // nothing
    }

    return new Uint8Array(crypto.publicEncrypt(options, data)).buffer;
  }

  protected static decryptOAEP(algorithm: RsaOaepParams, key: RsaPrivateKey, data: Uint8Array) {
    const options: crypto.RsaPrivateKey = {
      key: `-----BEGIN PRIVATE KEY-----\n${key.data.toString("base64")}\n-----END PRIVATE KEY-----`,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    };
    if (algorithm.label) {
      // nothing
    }

    return new Uint8Array(crypto.privateDecrypt(options, data)).buffer;
  }

}
