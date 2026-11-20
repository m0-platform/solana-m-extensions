// LiteSVM 1.x speaks @solana/kit and is the first release that loads sBPFv3 programs.
// The tests speak web3.js and Anchor, so this file adapts one to the other.
// LiteSVMProvider is adapted from anchor-litesvm (MIT, https://github.com/LiteSVM/litesvm).
import {
  AccountInfo,
  Commitment,
  ConfirmOptions,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendOptions,
  SendTransactionError,
  Signer,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { Provider, Wallet } from "@coral-xyz/anchor";
import { SuccessfulTxSimulationResponse } from "@coral-xyz/anchor/dist/cjs/utils/rpc";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {
  address,
  getTransactionDecoder,
  lamports,
  Signature,
} from "@solana/kit";
import {
  Clock,
  FailedTransactionMetadata,
  LiteSVM as KitLiteSVM,
  Rent,
  TransactionMetadata,
} from "litesvm";

export { Clock, FailedTransactionMetadata, TransactionMetadata };

type KitTransaction = Parameters<KitLiteSVM["sendTransaction"]>[0];
type AnyTransaction = Transaction | VersionedTransaction;

const toAddress = (pk: PublicKey) => address(pk.toBase58());

function toKitTransaction(tx: AnyTransaction): KitTransaction {
  const bytes =
    tx instanceof Transaction
      ? tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      : tx.serialize();
  return getTransactionDecoder().decode(bytes) as KitTransaction;
}

// The web3.js-shaped LiteSVM the tests were written against.
export class LiteSVM {
  readonly inner = new KitLiteSVM();

  withSplPrograms(): this {
    this.inner.withDefaultPrograms();
    return this;
  }
  withBuiltins(): this {
    this.inner.withBuiltins();
    return this;
  }
  withSysvars(): this {
    this.inner.withSysvars();
    return this;
  }
  withPrecompiles(): this {
    this.inner.withPrecompiles();
    return this;
  }
  withBlockhashCheck(check: boolean): this {
    this.inner.withBlockhashCheck(check);
    return this;
  }

  addProgramFromFile(programId: PublicKey, file: string) {
    this.inner.addProgramFromFile(toAddress(programId), file);
  }

  airdrop(pk: PublicKey, amount: bigint) {
    return this.inner.airdrop(toAddress(pk), lamports(amount));
  }

  getAccount(pk: PublicKey): AccountInfo<Uint8Array> | null {
    const account = this.inner.getAccount(toAddress(pk));
    if (!account.exists) return null;
    return {
      lamports: Number(account.lamports),
      data: account.data,
      owner: new PublicKey(account.programAddress),
      executable: account.executable,
      rentEpoch: 0,
    };
  }

  getBalance(pk: PublicKey): bigint | null {
    const account = this.inner.getAccount(toAddress(pk));
    return account.exists ? BigInt(account.lamports) : null;
  }

  setAccount(pk: PublicKey, account: AccountInfo<Uint8Array>) {
    this.inner.setAccount({
      address: toAddress(pk),
      data: Uint8Array.from(account.data),
      executable: account.executable,
      lamports: lamports(BigInt(account.lamports)),
      programAddress: toAddress(account.owner),
      space: BigInt(account.data.length),
    });
  }

  latestBlockhash(): string {
    return this.inner.latestBlockhash();
  }
  expireBlockhash() {
    this.inner.expireBlockhash();
  }
  getClock(): Clock {
    return this.inner.getClock();
  }
  setClock(clock: Clock) {
    this.inner.setClock(clock);
  }
  getRent(): Rent {
    return this.inner.getRent();
  }

  sendTransaction(tx: AnyTransaction) {
    return this.inner.sendTransaction(toKitTransaction(tx));
  }
  simulateTransaction(tx: AnyTransaction) {
    return this.inner.simulateTransaction(toKitTransaction(tx));
  }
  getTransaction(signature: Uint8Array) {
    return this.inner.getTransaction(bs58.encode(signature) as Signature);
  }
}

function signatureOf(tx: AnyTransaction): string {
  const signature = "version" in tx ? tx.signatures[0] : tx.signature;
  if (!signature) throw new Error("Missing fee payer signature");
  return bs58.encode(signature);
}

function throwIfFailed(
  result: unknown,
  action: "send" | "simulate",
  tx: AnyTransaction
) {
  if (result instanceof FailedTransactionMetadata) {
    throw new SendTransactionError({
      action,
      signature: signatureOf(tx),
      transactionMessage: result.err().toString(),
      logs: result.meta().logs(),
    });
  }
}

export class LiteSVMProvider implements Provider {
  wallet: Wallet;
  connection: Connection;
  publicKey: PublicKey;

  constructor(public client: LiteSVM, wallet?: Wallet) {
    if (!wallet) {
      const payer = new Keypair();
      client.airdrop(payer.publicKey, BigInt(LAMPORTS_PER_SOL));
      wallet = new Wallet(payer);
    }
    this.wallet = wallet;
    this.publicKey = wallet.publicKey;

    const getAccountInfo = async (pk: PublicKey) => {
      const account = client.getAccount(pk);
      if (!account) throw new Error(`Could not find ${pk.toBase58()}`);
      return { ...account, data: Buffer.from(account.data) };
    };
    this.connection = {
      getAccountInfo,
      getAccountInfoAndContext: async (pk: PublicKey) => ({
        context: { slot: Number(client.getClock().slot) },
        value: await getAccountInfo(pk),
      }),
      getMinimumBalanceForRentExemption: async (dataLength: number) =>
        Number(client.getRent().minimumBalance(BigInt(dataLength))),
    } as unknown as Connection;
  }

  // Adds the blockhash and the extra signers to a legacy transaction, or the signers to a versioned one.
  private prepare(
    tx: AnyTransaction,
    signers: Signer[] = [],
    blockhash = this.client.latestBlockhash()
  ) {
    if ("version" in tx) {
      if (signers.length) tx.sign(signers);
      return;
    }
    tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
    tx.recentBlockhash = blockhash;
    signers.forEach((signer) => tx.partialSign(signer));
  }

  async send(
    tx: AnyTransaction,
    signers?: Signer[],
    _opts?: SendOptions
  ): Promise<string> {
    this.prepare(tx, signers);
    await this.wallet.signTransaction(tx);
    this.client.sendTransaction(tx);
    return signatureOf(tx);
  }

  async sendAndConfirm(
    tx: AnyTransaction,
    signers?: Signer[],
    _opts?: ConfirmOptions
  ): Promise<string> {
    this.prepare(tx, signers);
    await this.wallet.signTransaction(tx);
    throwIfFailed(this.client.sendTransaction(tx), "send", tx);
    return signatureOf(tx);
  }

  async sendAll<T extends AnyTransaction>(
    txWithSigners: { tx: T; signers?: Signer[] }[],
    _opts?: ConfirmOptions
  ): Promise<string[]> {
    const blockhash = this.client.latestBlockhash();
    txWithSigners.forEach(({ tx, signers }) =>
      this.prepare(tx, signers, blockhash)
    );
    const signed = await this.wallet.signAllTransactions(
      txWithSigners.map(({ tx }) => tx)
    );
    return signed.map((tx) => {
      throwIfFailed(this.client.sendTransaction(tx), "send", tx);
      return signatureOf(tx);
    });
  }

  async simulate(
    tx: AnyTransaction,
    signers?: Signer[],
    _commitment?: Commitment,
    includeAccounts?: boolean | PublicKey[]
  ): Promise<SuccessfulTxSimulationResponse> {
    if (includeAccounts !== undefined)
      throw new Error("includeAccounts cannot be used with LiteSVMProvider");
    this.prepare(tx, signers);
    const result = this.client.simulateTransaction(tx);
    throwIfFailed(result, "simulate", tx);
    const meta = (
      result as Exclude<typeof result, FailedTransactionMetadata>
    ).meta();
    const returnData = meta.returnData();
    return {
      logs: meta.logs(),
      unitsConsumed: Number(meta.computeUnitsConsumed()),
      returnData: {
        programId: new PublicKey(returnData.programId()).toBase58(),
        data: [Buffer.from(returnData.data()).toString("base64"), "base64"],
      },
    };
  }
}
