import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LendingPool } from "../target/types/lending_pool";
import {
    Keypair,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
    ExtensionType,
    createInitializeInterestBearingMintInstruction,
    createInitializeMintInstruction,
    getMintLen,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    amountToUiAmount,
    getInterestBearingMintConfigState,
    getMint,
    createAssociatedTokenAccount,
    getAssociatedTokenAddressSync,
    mintTo,
    createSetAuthorityInstruction,
    AuthorityType,
    createInitializeMetadataPointerInstruction,
    getTokenMetadata,
    TYPE_SIZE,
    LENGTH_SIZE,
} from "@solana/spl-token";

import {
    createInitializeInstruction,
    createUpdateFieldInstruction,
    pack,
    TokenMetadata,
} from "@solana/spl-token-metadata";

import { expect } from "chai";

function logTransactionSignature(transactionSignature: string) {
    const cluster = "custom&customUrl=http%3A%2F%2Flocalhost%3A8899";

    console.log(
        `\thttps://explorer.solana.com/tx/${transactionSignature}?cluster=${cluster}\n`,
    );
}

describe("lending-pool", () => {
    // Configure the client to use the local cluster.
    anchor.setProvider(anchor.AnchorProvider.env());
    const provider = anchor.AnchorProvider.env();
    const program = anchor.workspace.LendingPool as Program<LendingPool>;
    const connection = provider.connection;
    const payer = provider.wallet as anchor.Wallet;

    // Generate new keypair for Mint Account
    const iSolMintKeypair = Keypair.generate();
    const iSolMint = iSolMintKeypair.publicKey;
    // Decimals for Mint Account
    const iSolDecimals = 9;
    // Authority that can mint new tokens
    let iSolMintAuthority = (provider.wallet as anchor.Wallet).publicKey;
    // Authority that can update the interest rate
    const iSolRateAuthority = provider.wallet;
    // Interest rate basis points (100 = 1%)
    // Max value = 32,767 (i16)
    const iSolRate = 0;
    // Size of Mint Account with extension
    const iSolMintLen = getMintLen([ExtensionType.InterestBearingConfig, ExtensionType.MetadataPointer]);

    // Generate new keypair for USDC Mint Account
    const usdcMintKeypair = Keypair.generate();
    const usdcMint = usdcMintKeypair.publicKey;
    const usdcDecimals = 6; // USDC typically has 6 decimals
    const usdcMintAuthority = provider.wallet as anchor.Wallet;
    const usdcMintLen = getMintLen([ExtensionType.MetadataPointer]); // Assuming USDC mint has Metadata extension


    // Generate new keypairs for HolderA and HolderB
    const holderA = Keypair.generate();
    const holderB = Keypair.generate();
    const holderAATA = getAssociatedTokenAddressSync(
        iSolMint, // Mint address
        holderA.publicKey, // Owner's public key
        false, // Allow owner off curve (default: false)
        TOKEN_2022_PROGRAM_ID // Token program ID
    );
    const holderBATA = getAssociatedTokenAddressSync(
        iSolMint, // Mint address
        holderB.publicKey, // Owner's public key
        false, // Allow owner off curve (default: false)
        TOKEN_2022_PROGRAM_ID // Token program ID
    );

    // Generate new keypair for BorrowerA
    const borrowerA = Keypair.generate();
    const borrowerAATA = getAssociatedTokenAddressSync(
        usdcMint, // Mint address
        borrowerA.publicKey, // Owner's public key
        false, // Allow owner off curve (default: false)
        TOKEN_2022_PROGRAM_ID // Token program ID
    );

    const depositorALamports = 2 * LAMPORTS_PER_SOL;
    const depositorBLamports = 3 * LAMPORTS_PER_SOL;

    // Derive the pool PDA using "pool" as the seed
    const [poolPda, _poolBump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool")],
        program.programId
    );

    // Derive the PDA address for the collateral_ta_pda
    const [collateralTaPda, _] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("collateral")],
        program.programId
    );

    // Derive the PDA for the iSOL Mint authority
    const [pda_iSolMintAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("isol_mint_auth")],
        program.programId
    );

    async function amountToUiAmountAtTimestamp(amount: number, unix_timestamp: number) {
        const tx = await program.methods.amountToUiAmount(
            new anchor.BN(amount),
            new anchor.BN(unix_timestamp)
        ).accountsStrict({
            isolMint: iSolMint,
        })
            .transaction();

        const { returnData, err } = (await connection.simulateTransaction(tx, [payer.payer], false)).value;
        if (returnData?.data) {
            return Buffer.from(returnData.data[0], returnData.data[1]).toString('utf-8');
        }
        return err;
    }

    // Print all public keys generated above
    console.log("HolderA ATA:", holderAATA.toBase58());
    console.log("HolderB ATA:", holderBATA.toBase58());
    console.log("BorrowerA ATA:", borrowerAATA.toBase58());
    console.log("HolderA:", holderA.publicKey.toBase58());
    console.log("HolderB:", holderB.publicKey.toBase58());
    console.log("BorrowerA:", borrowerA.publicKey.toBase58());
    console.log("iSol Mint:", iSolMint.toBase58());
    console.log("iSol Mint Authority BEFORE init:", iSolMintAuthority.toBase58());
    console.log("iSol Mint Authority AFTER init:", pda_iSolMintAuthority.toBase58());
    console.log("Rate Authority:", iSolRateAuthority.publicKey.toBase58());
    console.log("Payer:", payer.publicKey.toBase58());
    console.log("System Program:", SystemProgram.programId.toBase58());
    console.log("Token Program:", TOKEN_2022_PROGRAM_ID.toBase58());
    console.log("Associated Token Program:", ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    console.log("Lending Pool Program:", program.programId.toBase58());
    console.log("Pool PDA:", poolPda.toBase58());
    console.log("USDC Mint:", usdcMint.toBase58());
    console.log("USDC Mint Authority:", usdcMintAuthority.publicKey.toBase58());

    it("Creates a dummy USDC Mint account", async () => {

        const metaData: TokenMetadata = {
            mint: usdcMint,
            updateAuthority: usdcMintAuthority.publicKey,
            name: "USDC",
            symbol: "USDC",
            uri: "",
            additionalMetadata: [["Notice", "This is a dummy USDC mint for testing purposes only"]],
        };

        // Size of MetadataExtension 2 bytes for type, 2 bytes for length
        const metadataExtension = TYPE_SIZE + LENGTH_SIZE;

        // Size of metadata
        const metadataLen = pack(metaData).length;

        // Minimum lamports required for USDC Mint Account
        const usdcLamports = await connection.getMinimumBalanceForRentExemption(
            usdcMintLen + metadataExtension + metadataLen,
        );

        // Instruction to invoke System Program to create new account
        const createUsdcAccountInstruction = SystemProgram.createAccount({
            fromPubkey: payer.publicKey, // Account that will transfer lamports to created account
            newAccountPubkey: usdcMint, // Address of the account to create
            space: usdcMintLen, // Amount of bytes to allocate to the created account
            lamports: usdcLamports, // Amount of lamports transferred to created account
            programId: TOKEN_2022_PROGRAM_ID, // Program assigned as owner of created account
        });

        // Instruction to initialize the MetadataPointer Extension
        const initializeMetadataPointerInstruction =
            createInitializeMetadataPointerInstruction(
                usdcMint, // Mint Account address 
                usdcMintAuthority.publicKey, // Authority that can set the metadata address
                usdcMint, // Account address that holds the metadata
                TOKEN_2022_PROGRAM_ID,
            );

        // Instruction to initialize Mint Account data
        const initializeUsdcMintInstruction = createInitializeMintInstruction(
            usdcMint, // Mint Account Address
            usdcDecimals, // Decimals of Mint
            usdcMintAuthority.publicKey, // Designated Mint Authority
            null, // Optional Freeze Authority
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );

        // Instruction to initialize Metadata Account data
        const initializeMetadataInstruction = createInitializeInstruction({
            programId: TOKEN_2022_PROGRAM_ID, // Token Extension Program as Metadata Program
            metadata: metaData.mint, // Account address that holds the metadata
            updateAuthority: metaData.updateAuthority, // Authority that can update the metadata
            mint: metaData.mint, // Mint Account address
            mintAuthority: usdcMintAuthority.publicKey, // Designated Mint Authority
            name: metaData.name,
            symbol: metaData.symbol,
            uri: metaData.uri,
        });

        // Instruction to update metadata, adding custom field
        const updateFieldInstruction = createUpdateFieldInstruction({
            programId: TOKEN_2022_PROGRAM_ID, // Token Extension Program as Metadata Program
            metadata: metaData.mint, // Account address that holds the metadata
            updateAuthority: metaData.updateAuthority, // Authority that can update the metadata
            field: metaData.additionalMetadata[0][0], // key
            value: metaData.additionalMetadata[0][1], // value
        });

        // Add instructions to new transaction
        const usdcTransaction = new Transaction().add(
            createUsdcAccountInstruction,
            initializeMetadataPointerInstruction,
            initializeUsdcMintInstruction,
            initializeMetadataInstruction,
            updateFieldInstruction
        );

        // Send transaction
        const usdcTransactionSignature = await sendAndConfirmTransaction(
            connection,
            usdcTransaction,
            [payer.payer, usdcMintKeypair], // Signers
            {
                commitment: "confirmed",
            },
        );

        logTransactionSignature(usdcTransactionSignature);

        const downloadedMetadata: TokenMetadata = await getTokenMetadata(connection, usdcMint, "confirmed", TOKEN_2022_PROGRAM_ID);
        console.log("Downloaded Metadata:", downloadedMetadata);


        // Create a new throw-away ATA for testing
        const throwAwayATA = await createAssociatedTokenAccount(
            connection,
            payer.payer,
            usdcMint,
            payer.publicKey,
            {
                commitment: "confirmed",
            },
            TOKEN_2022_PROGRAM_ID,
        );

        // Mint 10 USDC to the throw-away ATA
        const mintAmount = 10 * 10 ** usdcDecimals;
        await mintTo(
            connection,
            payer.payer,
            usdcMint,
            throwAwayATA,
            usdcMintAuthority.publicKey,
            mintAmount,
            [],
            {
                commitment: "confirmed",
            },
            TOKEN_2022_PROGRAM_ID,
        );

        // Check the balance of the throw-away ATA
        const throwAwayATABalance = await connection.getTokenAccountBalance(throwAwayATA);
        console.log(`Throw-away ATA Balance: ${throwAwayATABalance.value.uiAmount} USDC`);
    });

    it("Airdrops SOL to HolderA and HolderB", async () => {
        const rentExemptionForSystemAccount = await connection.getMinimumBalanceForRentExemption(0);
        const rentExemptionForTokenAccount = await connection.getMinimumBalanceForRentExemption(iSolMintLen);

        const totalAirdropHolderA = 2 * LAMPORTS_PER_SOL + rentExemptionForSystemAccount + rentExemptionForTokenAccount;
        const totalAirdropHolderB = 3 * LAMPORTS_PER_SOL + rentExemptionForSystemAccount + rentExemptionForTokenAccount;

        await connection.requestAirdrop(holderA.publicKey, totalAirdropHolderA); // 2 SOL + rent exemption
        await connection.requestAirdrop(holderB.publicKey, totalAirdropHolderB); // 3 SOL + rent exemption
    });

    it("Creates a token Mint account with Interest Bearing and Metadata extensions", async () => {

        // Metadata for iSOL
        const metaData: TokenMetadata = {
            mint: iSolMint,
            updateAuthority: iSolMintAuthority,
            name: "iSOL",
            symbol: "iSOL",
            uri: "",
            additionalMetadata: [["Notice", "This is a 1:1 iSOL mint for testing purposes only"]],
        };

        // Size of MetadataExtension 2 bytes for type, 2 bytes for length
        const metadataExtension = TYPE_SIZE + LENGTH_SIZE;

        // Size of metadata
        const metadataLen = pack(metaData).length;

        // Minimum lamports required for Mint Account with metadata
        const lamports = await connection.getMinimumBalanceForRentExemption(
            iSolMintLen + metadataExtension + metadataLen,
        );

        // Instruction to invoke System Program to create new account
        const createAccountInstruction = SystemProgram.createAccount({
            fromPubkey: payer.publicKey, // Account that will transfer lamports to created account
            newAccountPubkey: iSolMint, // Address of the account to create
            space: iSolMintLen, // Amount of bytes to allocate to the created account
            lamports, // Amount of lamports transferred to created account
            programId: TOKEN_2022_PROGRAM_ID, // Program assigned as owner of created account
        });

        // Instruction to initialize the InterestBearingConfig Extension
        const initializeInterestBearingMintInstruction =
            createInitializeInterestBearingMintInstruction(
                iSolMint, // Mint Account address
                iSolRateAuthority.publicKey, // Designated Rate Authority
                iSolRate, // Interest rate basis points
                TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
            );

        // Instruction to initialize Mint Account data
        const initializeMintInstruction = createInitializeMintInstruction(
            iSolMint, // Mint Account Address
            iSolDecimals, // Decimals of Mint
            iSolMintAuthority, // Designated Mint Authority
            null, // Optional Freeze Authority
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );

        // Instruction to initialize the MetadataPointer Extension
        const initializeMetadataPointerInstruction =
            createInitializeMetadataPointerInstruction(
                iSolMint, // Mint Account address 
                iSolMintAuthority, // Authority that can set the metadata address
                iSolMint, // Account address that holds the metadata
                TOKEN_2022_PROGRAM_ID,
            );

        // Instruction to initialize Metadata Account data
        const initializeMetadataInstruction = createInitializeInstruction({
            programId: TOKEN_2022_PROGRAM_ID, // Token Extension Program as Metadata Program
            metadata: metaData.mint, // Account address that holds the metadata
            updateAuthority: metaData.updateAuthority, // Authority that can update the metadata
            mint: metaData.mint, // Mint Account address
            mintAuthority: iSolMintAuthority, // Designated Mint Authority
            name: metaData.name,
            symbol: metaData.symbol,
            uri: metaData.uri,
        });

        // Instruction to update metadata, adding custom field
        const updateFieldInstruction = createUpdateFieldInstruction({
            programId: TOKEN_2022_PROGRAM_ID, // Token Extension Program as Metadata Program
            metadata: metaData.mint, // Account address that holds the metadata
            updateAuthority: metaData.updateAuthority, // Authority that can update the metadata
            field: metaData.additionalMetadata[0][0], // key
            value: metaData.additionalMetadata[0][1], // value
        });

        // Add instructions to new transaction
        const transaction = new Transaction().add(
            createAccountInstruction,
            initializeInterestBearingMintInstruction,
            initializeMetadataPointerInstruction,
            initializeMintInstruction,
            initializeMetadataInstruction,
            updateFieldInstruction
        );

        // Send transaction
        const transactionSignature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [payer.payer, iSolMintKeypair], // Signers
        );

        logTransactionSignature(transactionSignature);
    });

    it("Lending Program is initialized!", async () => {
        const tx = await program.methods.initialize()
            .accounts({
                payer: provider.wallet.publicKey,
                collateralMint: usdcMint,
            })
            .signers([payer.payer])
            .rpc();

        logTransactionSignature(tx);

        // Transfer authority to PDA.
        // Add instruction to new transaction
        const setAuthorityTransaction = new Transaction().add(
            createSetAuthorityInstruction(
                iSolMint,
                iSolMintAuthority,
                AuthorityType.MintTokens,
                pda_iSolMintAuthority,
                [],
                TOKEN_2022_PROGRAM_ID
            ),
            createSetAuthorityInstruction(
                iSolMint,
                iSolMintAuthority,
                AuthorityType.InterestRate,
                pda_iSolMintAuthority,
                [],
                TOKEN_2022_PROGRAM_ID
            )
        );

        // Send transaction
        const setAuthoritySignature = await sendAndConfirmTransaction(
            connection,
            setAuthorityTransaction,
            [payer.payer],
        );

        console.log(`\tAssigning iSOL Mint authority to PDA: ${pda_iSolMintAuthority.toBase58()}`);
        iSolMintAuthority = pda_iSolMintAuthority;

        logTransactionSignature(setAuthoritySignature);

    });

    it("Registers depositors", async () => {
        const tx1 = await program.methods.registerDepositor()
            .accountsStrict({
                depositor: holderA.publicKey,
                mint: iSolMint,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                depositorAta: holderAATA,
            })
            .signers([holderA])
            .rpc();
        logTransactionSignature(tx1);

        const tx2 = await program.methods.registerDepositor()
            .accountsStrict({
                depositor: holderB.publicKey,
                mint: iSolMint,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                depositorAta: holderBATA,
            })
            .signers([holderB])
            .rpc();

        logTransactionSignature(tx2);
    });

    it("Deposits SOL and mints iSOL tokens", async () => {

        // Deposit SOL into the lending pool and mint iSOL tokens
        // This part will depend on your lending pool program's implementation
        // Assuming you have a deposit method in your program
        await program.methods.deposit(new anchor.BN(depositorALamports)) // 2 SOL
            .accountsStrict({
                depositor: holderA.publicKey,
                isolMint: iSolMint,
                isolMintAuthority: iSolMintAuthority,
                depositorAta: holderAATA,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                poolPda: poolPda,
            })
            .signers([holderA])
            .rpc();

        await program.methods.deposit(new anchor.BN(depositorBLamports)) // 3 SOL
            .accountsStrict({
                depositor: holderB.publicKey,
                isolMint: iSolMint,
                isolMintAuthority: iSolMintAuthority,
                depositorAta: holderBATA,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                poolPda: poolPda,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .signers([holderB])
            .rpc();

        // Check balances of iSOL tokens in HolderA and HolderB's ATAs
        const holderA_iSolBalance = await connection.getTokenAccountBalance(holderAATA);
        const holderB_iSolBalance = await connection.getTokenAccountBalance(holderBATA);

        const holderA_iSolBalanceInSOL = holderA_iSolBalance.value.uiAmount;
        const holderB_iSolBalanceInSOL = holderB_iSolBalance.value.uiAmount;

        // Convert amount to UI amount with accrued interest
        const holderA_AccruedValueAmount = await amountToUiAmount(
            connection, // Connection to the Solana cluster
            payer.payer, // Account that will transfer lamports for the transaction
            iSolMint, // Address of the Mint account
            BigInt(holderA_iSolBalance.value.amount), // Amount to be converted
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );
        const holderB_AccruedValueAmount = await amountToUiAmount(
            connection, // Connection to the Solana cluster
            payer.payer, // Account that will transfer lamports for the transaction
            iSolMint, // Address of the Mint account
            BigInt(holderB_iSolBalance.value.amount), // Amount to be converted
            TOKEN_2022_PROGRAM_ID, // Token Extension Program ID
        );

        console.log(`\tHolderA Balance: ${holderA_iSolBalanceInSOL} iSOL = ${holderA_AccruedValueAmount} SOL`);
        console.log(`\tHolderB Balance: ${holderB_iSolBalanceInSOL} iSOL = ${holderB_AccruedValueAmount} SOL`);
    });

    it("BorrowerA borrows SOL using USDC as collateral", async () => {
        const rentExemptionForSystemAccount = await connection.getMinimumBalanceForRentExemption(0);
        const rentExemptionForTokenAccount = await connection.getMinimumBalanceForRentExemption(usdcMintLen);

        const totalAirdropBorrowerA = rentExemptionForSystemAccount + rentExemptionForTokenAccount;

        // Airdrop SOL to BorrowerA for transaction fees and rent exemption
        console.log("\tFunding BorrowerA with rent-exemption SOL...");
        await connection.requestAirdrop(borrowerA.publicKey, totalAirdropBorrowerA);

        // Create BorrowerA's ATA for USDC
        console.log("\tCreating BorrowerA's ATA for USDC...");
        await createAssociatedTokenAccount(
            connection,
            payer.payer,
            usdcMint,
            borrowerA.publicKey,
            {
                commitment: "confirmed",
            },
            TOKEN_2022_PROGRAM_ID,
        );

        // Mint 2000 USDC to BorrowerA's ATA
        const totalUSDC = 2000 * 10 ** usdcDecimals;
        await mintTo(
            connection,
            payer.payer,
            usdcMint,
            borrowerAATA,
            usdcMintAuthority.publicKey,
            totalUSDC,
            [],
            {
                commitment: "confirmed",
            },
            TOKEN_2022_PROGRAM_ID,
        )

        // Derive the loan record PDA
        const [loanRecordPda, _] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("loan"), borrowerA.publicKey.toBuffer()],
            program.programId
        );

        // Borrow 3.465 SOL (69.3% of the pool)
        // By the end of the year, holders will have doubled their deposits.
        const borrowAmount = new anchor.BN(3.465 * LAMPORTS_PER_SOL);
        const borrowTx = await program.methods.borrow(borrowAmount)
            .accountsStrict({
                borrower: borrowerA.publicKey,
                borrowerAta: borrowerAATA,
                collateralMint: usdcMint,
                collateralPoolPda: collateralTaPda,
                poolPda: poolPda,
                isolMint: iSolMint,
                isolMintAuthority: iSolMintAuthority,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                loanRecord: loanRecordPda,
            })
            .signers([borrowerA])
            .rpc({ commitment: "confirmed" });

        logTransactionSignature(borrowTx);

        // The borrowing interest rate has now increased.
        const mintInfo = await getMint(
            connection,
            iSolMint,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
        );

        const interestBearingConfig = await getInterestBearingMintConfigState(
            mintInfo,
        );

        if (interestBearingConfig) {
            const RATE_DECIMALS = 100;
            const currentRate = interestBearingConfig.currentRate;
            const currentRatePercentage = currentRate / RATE_DECIMALS;
            expect(currentRatePercentage).equals(69.3, "Utilization rate 69.3%.");
            console.log(`\tCurrent interest rate: ${currentRate} basis points (${currentRatePercentage}%)`);
        } else {
            throw new Error("InterestBearingConfig not found on iSOL mint");
        }

        // Verify that the loan record PDA was created
        const loanRecordAccount = await program.account.loanRecord.fetch(loanRecordPda);
        expect(loanRecordAccount).to.not.be.null;

        // Calculate the expected total amount to repay (principal + interest)
        const BASIS_DIVISOR = 10000;
        const borrowAmountNumber = borrowAmount.toNumber();
        const interestAmount = Math.floor((borrowAmountNumber * interestBearingConfig.currentRate) / BASIS_DIVISOR);
        const expectedTotalAmount = borrowAmountNumber + interestAmount;
        expect(loanRecordAccount.amount.toNumber()).to.equal(expectedTotalAmount);
        expect(loanRecordAccount.expirationTime.toNumber()).to.be.greaterThan(0);

        console.log(`\tBorrowed amount: ${borrowAmountNumber / LAMPORTS_PER_SOL} SOL`);
        console.log(`\tInterest amount: ${interestAmount / LAMPORTS_PER_SOL} SOL`);
        console.log(`\tTotal amount to repay: ${expectedTotalAmount / LAMPORTS_PER_SOL} SOL`);
    });

    it("Holders double iSOL appreciation after 1 year", async () => {
        const SECONDS_PER_YEAR = 60 * 60 * 24 * 365.24;
        const MILLISECONDS_PER_SECOND = 1000;
        const oneYearFromNow = Date.now() / MILLISECONDS_PER_SECOND + SECONDS_PER_YEAR;
        const EPSILON = 0.001;

        const holderAiSolBalance = await connection.getTokenAccountBalance(holderAATA);
        const uiAmountA = await amountToUiAmountAtTimestamp(Number(holderAiSolBalance.value.amount), oneYearFromNow);
        const actualUiAmountA = Number(uiAmountA);
        const expectedUiAmountA = (depositorALamports * 2) / LAMPORTS_PER_SOL;
        console.log(`\tHolderA's iSOL balance in SOL 1 YEAR FROM NOW: ${actualUiAmountA} (approx. ${expectedUiAmountA.toFixed()} SOL)`);

        expect(Math.abs(actualUiAmountA - expectedUiAmountA)).is.lessThan(EPSILON);

        const holderBiSolBalance = await connection.getTokenAccountBalance(holderBATA);
        const uiAmountB = await amountToUiAmountAtTimestamp(Number(holderBiSolBalance.value.amount), oneYearFromNow);
        const actualUiAmountB = Number(uiAmountB);
        const expectedUiAmountB = (depositorBLamports * 2) / LAMPORTS_PER_SOL;
        console.log(`\tHolderB's iSOL balance in SOL 1 YEAR FROM NOW: ${actualUiAmountB} (approx. ${expectedUiAmountB.toFixed()} SOL)`);

        expect(Math.abs(actualUiAmountB - expectedUiAmountB)).is.lessThan(EPSILON);
    });
});