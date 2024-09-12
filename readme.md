> :warning: Not meant to be used in production.  


# What is this?
This is a reference implementation of a Solana lending pool program, using the Interest Bearing token extension to represent shares of the pool, and built with Anchor. 
This implementation illustrates how on-chain protocols influence [client-side implementations](https://solana.com/developers/guides/token-extensions/interest-bearing-tokens).  

# How to run
1. Clone the repository
2. Run `anchor build`
3. Run `anchor test`

# What does this reference implementation do?
See the tests in [lending-pool.ts](tests/lending-pool.ts) for implementation details. At a high level, it does the following:
- Creates a lending pool from SOL deposits in exchange for iSOL interest-bearing shares.
- Allows users to borrow SOL with USDC collateral.
- Immediately accrues interest on the pool upon borrowing.

```mermaid
flowchart TD
 subgraph subgraph_1ktz23e5x["Lending"]
        ne["SOL Lend Prog<br>"]
        n1["Pool<br>[5k SOL]"]
        n4["Collateral<br>[0 USDC]"]
  end
 subgraph subgraph_qkzpoz6u9["Interest"]
        node_qdujp98uo["iSOL Mint<br>[Interest Bearing Ext]"]
        n0["HolderA_ATA<br>[2k iSOL]"]
        ng["HolderB_ATA<br>[3k iSOL]"]
  end
 subgraph subgraph_yc1100259["HolderB's Wallet"]
        node_ns14q8hs5["Private Key"]
        nf["FrontEnd"]
  end
    n2["HolderA Acct<br>[<s>2k SOL</s> + Rent]"] -- Deposit 2k SOL --> ne
    n3["HolderB Acct<br>[<s>3k SOL</s> + Rent]"] -- Deposit 3k SOL --> ne
    ne -- Lend --> np("DeFi Protocols")
    np -- Yield --> n1
    ne -. PDA .- n1
    node_qdujp98uo --> n0 & ng
    ne -- Mint shares ---> node_qdujp98uo
    nf -- SOL Amount:<br>[Rent] --> n3
    nf -- "iSOL Value,in SOL:<br>[3k + Interest]<br>aka, **ui_amount**" --> ng

```

## Illustrated example
### Lending flow
```mermaid
flowchart TD
 subgraph subgraph_1ktz23e5x["Lending"]
        ne["SOL Lend Prog"]
        n1["Pool[SOL]"]
        n4["Collateral[USDC]"]
        n3["Loan record"]
  end
    %%ne -.-|PDA| n1 & n4 & n3
    ne -- 1a.Deposit --> n5["Borrower ATA [USDC]"]
    np("Borrower Acct[SOL]") -->|0.Borrow| ne
    n5 -- 1b.Transfer --> n4
    ne --->|2a.Lend| n1
    n1 -- 2c.Recieve ---> np
    n1 -->|2b.Record| n3
```
### Lending pool states
```mermaid
%%{init: {'themeVariables': { 'pie1': '#000000', 'pie2': '#440044', 'pie3': '#882288', 'pie4': '#444444', 'pie5': '#800080', 'pie6': '#ff0000', 'pie7': '#FFA500'}}}%%
pie title Step1: SOL Lending Pool Init
    "HolderA" : 2
    "HolderB" : 3
```

- No borrowers present.
- Interest rate is 0%.
    - Holders are not accumulating wealth.
- Interest rate == utilization rate (Borrowed / Deposits)  
  

```mermaid
%%{init: {'themeVariables': { 
'pie1': '#444444', 
'pie2': '#882288', 
'pie3': '#000000', 
'pie4': '#440044', 
'pie5': '#800080', 
'pie6': '#ff0000', 
'pie7': '#FFA500'}}}%%
pie title Step2: SOL Lending Pool Borrow
    "HolderB-Loaned" : 2.079
    "HolderA-Loaned" : 1.386
    "HolderB" : 0.921
    "HolderA" : 0.614

```
- A single borrower effectively borrows `69.3%` of the pool.
    - Each holder's contribution (marked by color shade) is uniformly reserved for the loan.
    - Due to compounding interest, this amount is borrowed to produce an interest rate that doubles holder earnings by EOY.
- Utilization rate is 69.3% = Interest rate is 69.3%.
    - Interest rate gets adjusted automatically upon issuing loans.
- Interest rate is based on 1 year __fixed rate.__
    - EOY projected repayment amount is committed upon borrowing.
    - Paying off early has no effect on interest rate.
- Borrower will settle with `3.465 SOL` loaned + `2.401245 SOL` interest = `5.866245 SOL`.
- Holders being accumulating interest upon borrowing because the loan is guaranteed via repayment or collateral liquidation.

```mermaid
%%{init: {'themeVariables': { 'pie1': '#000000', 'pie2': '#440044', 'pie3': '#882288', 'pie4': '#444444', 'pie5': '#800080', 'pie6': '#ff0000', 'pie7': '#FFA500'}}}%%
pie title Step3: SOL Lending Pool Repaid
    "HolderA" : 4
    "HolderB" : 6
```

```mermaid
    xychart-beta
    title "Pool Growth"
    x-axis [HolderA+, HolderB+, BorrowerA-]
    y-axis "SOL (in Lamports)" 0 --> 10
    bar [2, 3, 10]
```

# Features not yet implemented
- [ ] Withdrawing SOL
- [ ] Same user borrowing twice


# Features out of scope
- Liquidation mechanism.
