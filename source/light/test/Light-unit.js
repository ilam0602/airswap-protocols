const ethers = require('ethers')
const {
  time: { takeSnapshot, revertToSnapshot },
  assert: { emitted, reverted, notEmitted, equal },
} = require('@airswap/test-utils')
const { ADDRESS_ZERO, SECONDS_IN_DAY } = require('@airswap/constants')
const { createLightSignature } = require('@airswap/utils')
const { getPrivateKeyFromGanacheAccount } = require('./utils')

const Light = artifacts.require('Light')
const IERC20 = artifacts.require('IERC20')
const MockContract = artifacts.require('MockContract')

const emptySignature = {
  r: web3.utils.randomHex(32),
  s: web3.utils.randomHex(32),
  v: 0,
}
const ERC20Interface = new ethers.utils.Interface(IERC20.abi)
const encodeERC20Call = (name, args) =>
  ERC20Interface.encodeFunctionData(name, args)

const SIGNER_FEE = 300
const HIGHER_FEE = 500
const FEE_DIVISOR = 10000

function createOrder({
  expiry = Math.round(Date.now() / 1000 + SECONDS_IN_DAY).toString(),
  nonce = Date.now(),
  signerWallet = ADDRESS_ZERO,
  signerToken = ADDRESS_ZERO,
  signerAmount = 0,
  signerFee = SIGNER_FEE,
  senderWallet = ADDRESS_ZERO,
  senderToken = ADDRESS_ZERO,
  senderAmount = 0,
  v = emptySignature.v,
  r = emptySignature.r,
  s = emptySignature.s,
}) {
  return {
    expiry,
    nonce,
    signerWallet,
    signerToken,
    signerAmount,
    signerFee,
    senderWallet,
    senderToken,
    senderAmount,
    v,
    r,
    s,
  }
}

const signOrder = async (order, account, swapContract) => {
  const privKey = getPrivateKeyFromGanacheAccount(account)
  const signerWallet =
    order.signerWallet === ADDRESS_ZERO ? account : order.signerWallet
  const orderWithSigner = { ...order, signerWallet }
  const { v, r, s } = await createLightSignature(
    orderWithSigner,
    privKey,
    swapContract,
    1
  )

  return {
    ...orderWithSigner,
    v,
    r,
    s,
  }
}

function orderToParams(order) {
  return [
    order.nonce,
    order.expiry,
    order.signerWallet,
    order.signerToken,
    order.signerAmount,
    order.senderToken,
    order.senderAmount,
    order.v,
    order.r,
    order.s,
  ]
}

contract('Light Unit Tests', async accounts => {
  const [owner, mockSender, mockSigner, feeWallet, anyone] = accounts

  let snapshotId
  let swap
  let mockSignerToken
  let mockSenderToken

  const createOrderWithMockTokens = order =>
    createOrder({
      ...order,
      signerToken: mockSignerToken.address,
      senderToken: mockSenderToken.address,
    })

  beforeEach(async () => {
    const snapShot = await takeSnapshot()
    snapshotId = snapShot['result']
  })

  afterEach(async () => {
    await revertToSnapshot(snapshotId)
  })

  describe('Setup', () => {
    before('deploy Light', async () => {
      mockSignerToken = await MockContract.new()
      mockSenderToken = await MockContract.new()
    })

    it('test setting fee and fee wallet correctly', async () => {
      swap = await Light.new(feeWallet, SIGNER_FEE, { from: owner })
      const storedFee = await swap.signerFee.call()
      const storedFeeWallet = await swap.feeWallet.call()
      equal(storedFee.toNumber(), SIGNER_FEE)
      equal(storedFeeWallet, feeWallet)
    })

    it('test invalid feeWallet', async () => {
      await reverted(
        Light.new(ADDRESS_ZERO, SIGNER_FEE, { from: owner }),
        'INVALID_FEE_WALLET'
      )
    })

    it('test invalid fee', async () => {
      await reverted(
        Light.new(feeWallet, 100000000000, { from: owner }),
        'INVALID_FEE'
      )
    })
  })

  describe('Test swap', () => {
    before('deploy Light', async () => {
      swap = await Light.new(feeWallet, SIGNER_FEE, {
        from: owner,
      })
      mockSignerToken = await MockContract.new()
      mockSenderToken = await MockContract.new()
    })

    it('test transfers', async () => {
      const order = createOrderWithMockTokens({
        senderAmount: 1,
        signerAmount: 1,
        senderWallet: mockSender,
      })
      const signedOrder = await signOrder(order, mockSigner, swap.address)
      await mockSignerToken.givenAnyReturnBool(true)
      await mockSenderToken.givenAnyReturnBool(true)

      const tx = await swap.swap(...orderToParams(signedOrder), {
        from: mockSender,
      })

      emitted(tx, 'Swap', e => {
        return (
          e.nonce.toNumber() === order.nonce &&
          e.signerWallet === mockSigner &&
          e.senderWallet === order.senderWallet &&
          e.signerToken === order.signerToken &&
          e.senderToken === order.senderToken &&
          e.signerAmount.toNumber() === order.signerAmount &&
          e.senderAmount.toNumber() === order.senderAmount
        )
      })

      const senderTransferData = encodeERC20Call('transferFrom', [
        mockSender,
        mockSigner,
        1,
      ])
      const signerTransferData = encodeERC20Call('transferFrom', [
        mockSigner,
        mockSender,
        1,
      ])

      const senderTransferCalls = await mockSenderToken.invocationCountForCalldata.call(
        senderTransferData
      )
      const signerTransferCalls = await mockSignerToken.invocationCountForCalldata.call(
        signerTransferData
      )

      const allSignerTransferCalls = await mockSignerToken.invocationCountForMethod.call(
        signerTransferData
      )

      equal(senderTransferCalls.toNumber(), 1)
      equal(signerTransferCalls.toNumber(), 1)
      equal(allSignerTransferCalls.toNumber(), 1)
    })

    it('test authorized signer', async () => {
      const order = createOrderWithMockTokens({
        senderAmount: 1,
        signerAmount: 1,
        senderWallet: mockSender,
        signerWallet: anyone,
      })
      await swap.authorize(mockSigner, {
        from: anyone,
      })
      const signedOrder = await signOrder(order, mockSigner, swap.address)
      await mockSignerToken.givenAnyReturnBool(true)
      await mockSenderToken.givenAnyReturnBool(true)

      const tx = await swap.swap(...orderToParams(signedOrder), {
        from: mockSender,
      })

      emitted(tx, 'Swap', e => {
        return (
          e.nonce.toNumber() === order.nonce &&
          e.signerWallet === order.signerWallet &&
          e.senderWallet === order.senderWallet &&
          e.signerToken === order.signerToken &&
          e.senderToken === order.senderToken &&
          e.signerAmount.toNumber() === order.signerAmount &&
          e.senderAmount.toNumber() === order.senderAmount
        )
      })

      const senderTransferData = encodeERC20Call('transferFrom', [
        mockSender,
        anyone,
        1,
      ])
      const signerTransferData = encodeERC20Call('transferFrom', [
        anyone,
        mockSender,
        1,
      ])

      const senderTransferCalls = await mockSenderToken.invocationCountForCalldata.call(
        senderTransferData
      )
      const signerTransferCalls = await mockSignerToken.invocationCountForCalldata.call(
        signerTransferData
      )

      equal(senderTransferCalls.toNumber(), 1)
      equal(signerTransferCalls.toNumber(), 1)
    })

    it('test when order is expired', async () => {
      const order = createOrder({
        expiry: 0,
      })

      await reverted(swap.swap(...orderToParams(order)), 'EXPIRY_PASSED')
    })

    it('test when nonce has already been used', async () => {
      const order = createOrderWithMockTokens({
        nonce: 0,
        signerAmount: 200,
        senderAmount: 200,
        senderWallet: mockSender,
      })

      const signedOrder = await signOrder(order, mockSigner, swap.address)

      await mockSignerToken.givenAnyReturnBool(true)
      await mockSenderToken.givenAnyReturnBool(true)

      await swap.swap(...orderToParams(signedOrder), { from: mockSender })
      await reverted(
        swap.swap(...orderToParams(signedOrder), {
          from: mockSender,
        }),
        'NONCE_ALREADY_USED'
      )
    })

    it('test when nonce has been cancelled', async () => {
      await swap.cancel([0], { from: mockSigner })
      const order = createOrderWithMockTokens({
        nonce: 0,
        signerAmount: 200,
        senderAmount: 200,
        senderWallet: mockSender,
      })

      const signedOrder = await signOrder(order, mockSigner, swap.address)

      await mockSignerToken.givenAnyReturnBool(true)
      await mockSenderToken.givenAnyReturnBool(true)

      await reverted(
        swap.swap(...orderToParams(signedOrder), {
          from: mockSender,
        }),
        'NONCE_ALREADY_USED'
      )
    })

    it('test when signer not authorized', async () => {
      const order = createOrderWithMockTokens({
        nonce: 0,
        signerAmount: 200,
        senderAmount: 200,
        senderWallet: anyone,
      })

      const signedOrder = await signOrder(order, mockSigner, swap.address)

      await mockSignerToken.givenAnyReturnBool(true)
      await mockSenderToken.givenAnyReturnBool(true)

      await reverted(
        swap.swap(...orderToParams(signedOrder), {
          from: mockSender,
        }),
        'UNAUTHORIZED'
      )
    })

    it('test invalid signature', async () => {
      const invalidOrder = createOrderWithMockTokens({
        v: 123,
        r: '0x1',
        s: '0x2',
      })
      await reverted(
        swap.swap(...orderToParams(invalidOrder), {
          from: mockSender,
        }),
        'INVALID_SIG'
      )
    })
  })

  describe('Test fees', () => {
    const fee = 300
    before('deploy Light', async () => {
      swap = await Light.new(feeWallet, fee, {
        from: owner,
      })
      mockSignerToken = await MockContract.new()
      mockSenderToken = await MockContract.new()
    })

    it('test changing fee wallet', async () => {
      await swap.setFeeWallet(anyone, { from: owner })

      const storedFeeWallet = await swap.feeWallet.call()
      equal(storedFeeWallet, anyone)
    })

    it('test only owner can change fee wallet', async () => {
      await reverted(
        swap.setFeeWallet(anyone, { from: anyone }),
        'Ownable: caller is not the owner'
      )
    })

    it('test invalid fee wallet', async () => {
      await reverted(
        swap.setFeeWallet(ADDRESS_ZERO, { from: owner }),
        'INVALID_FEE_WALLET'
      )
    })

    it('test transfers with fee', async () => {
      const order = createOrderWithMockTokens({
        senderAmount: 1000,
        signerAmount: 1000,
        senderWallet: mockSender,
      })
      const signedOrder = await signOrder(order, mockSigner, swap.address)
      await mockSignerToken.givenAnyReturnBool(true)
      await mockSenderToken.givenAnyReturnBool(true)

      const tx = await swap.swap(...orderToParams(signedOrder), {
        from: mockSender,
      })

      emitted(tx, 'Swap', e => {
        return (
          e.nonce.toNumber() === order.nonce &&
          e.signerWallet === mockSigner &&
          e.senderWallet === order.senderWallet &&
          e.signerToken === order.signerToken &&
          e.senderToken === order.senderToken &&
          e.signerAmount.toNumber() === order.signerAmount &&
          e.senderAmount.toNumber() === order.senderAmount
        )
      })

      const senderTransferData = encodeERC20Call('transferFrom', [
        mockSender,
        mockSigner,
        1000,
      ])
      const signerTransferData = encodeERC20Call('transferFrom', [
        mockSigner,
        mockSender,
        1000,
      ])

      const feeTransferData = encodeERC20Call('transferFrom', [
        mockSigner,
        feeWallet,
        30,
      ])

      const senderTransferCalls = await mockSenderToken.invocationCountForCalldata.call(
        senderTransferData
      )
      const signerTransferCalls = await mockSignerToken.invocationCountForCalldata.call(
        signerTransferData
      )
      const feeTransferCalls = await mockSignerToken.invocationCountForCalldata.call(
        feeTransferData
      )

      equal(senderTransferCalls.toNumber(), 1)
      equal(signerTransferCalls.toNumber(), 1)
      equal(feeTransferCalls.toNumber(), 1)
    })

    it('test changing fee', async () => {
      await swap.setFee(HIGHER_FEE, { from: owner })

      const storedSignerFee = await swap.signerFee.call()
      equal(storedSignerFee, HIGHER_FEE)
    })

    it('test only owner can change fee', async () => {
      await reverted(
        swap.setFee(anyone, { from: anyone }),
        'Ownable: caller is not the owner'
      )
    })

    it('test invalid fee', async () => {
      await reverted(
        swap.setFee(FEE_DIVISOR + 1, { from: owner }),
        'INVALID_FEE'
      )
    })

    it('test when signed with incorrect fee', async () => {
      const order = createOrderWithMockTokens({
        signerFee: SIGNER_FEE,
      })

      const signedOrder = await signOrder(order, mockSigner, swap.address)

      await reverted(
        swap.swap(...orderToParams(signedOrder), {
          from: mockSender,
        }),
        'UNAUTHORIZED'
      )
    })
  })

  describe('Test authorization', () => {
    beforeEach('deploy Light', async () => {
      swap = await Light.new(feeWallet, 1, {
        from: owner,
      })
      mockSignerToken = await MockContract.new()
      mockSenderToken = await MockContract.new()
    })

    it('test authorized is set', async () => {
      const trx = await swap.authorize(mockSigner, { from: anyone })
      emitted(
        trx,
        'Authorize',
        e => e.signer === mockSigner && e.signerWallet === anyone
      )
      const authorized = await swap.authorized(anyone)
      equal(authorized, mockSigner)
    })

    it('test revoke', async () => {
      await swap.authorize(mockSigner, { from: anyone })
      const trx = await swap.revoke({ from: anyone })
      emitted(
        trx,
        'Revoke',
        e => e.signer === mockSigner && e.signerWallet === anyone
      )
      const authorized = await swap.authorized(anyone)
      equal(authorized, ADDRESS_ZERO)
    })
  })

  describe('Test cancel', async () => {
    beforeEach('deploy Light', async () => {
      swap = await Light.new(feeWallet, 1, {
        from: owner,
      })
      mockSignerToken = await MockContract.new()
      mockSenderToken = await MockContract.new()
    })

    it('test cancellation with no items', async () => {
      const trx = await swap.cancel([], { from: mockSigner })
      await notEmitted(trx, 'Cancel')
    })

    it('test cancellation with duplicated items', async () => {
      const trx = await swap.cancel([1, 1], { from: mockSigner })
      emitted(trx, 'Cancel', e => {
        return e.nonce.toNumber() === 1 && e.signerWallet === mockSigner
      })

      //ensure the value was set
      const val = await swap.nonceUsed.call(mockSigner, 1)
      equal(val, true)
    })

    it('test cancellation of same item twice', async () => {
      const trx = await swap.cancel([1], { from: mockSigner })
      emitted(trx, 'Cancel', e => {
        return e.nonce.toNumber() === 1 && e.signerWallet === mockSigner
      })
      const trx2 = await swap.cancel([1], { from: mockSigner })
      notEmitted(trx2, 'Cancel')

      //ensure the value was set
      const val = await swap.nonceUsed.call(mockSigner, 1)
      equal(val, true)
    })

    it('test cancellation with one item', async () => {
      const trx = await swap.cancel([6], { from: mockSigner })

      //ensure transaction was emitted
      emitted(trx, 'Cancel', e => {
        return e.nonce.toNumber() === 6 && e.signerWallet === mockSigner
      })

      //ensure the value was set
      const val = await swap.nonceUsed.call(mockSigner, 6)
      equal(val, true)
    })

    it('test an array of nonces, ensure the cancellation of only those orders', async () => {
      await swap.cancel([1, 2, 4, 6], { from: mockSigner })
      let val
      val = await swap.nonceUsed.call(mockSigner, 1)
      equal(val, true)
      val = await swap.nonceUsed.call(mockSigner, 2)
      equal(val, true)
      val = await swap.nonceUsed.call(mockSigner, 3)
      equal(val, false)
      val = await swap.nonceUsed.call(mockSigner, 4)
      equal(val, true)
      val = await swap.nonceUsed.call(mockSigner, 5)
      equal(val, false)
      val = await swap.nonceUsed.call(mockSigner, 6)
      equal(val, true)
    })
  })
})