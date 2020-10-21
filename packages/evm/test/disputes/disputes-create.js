const { ONE_DAY, NEXT_WEEK, bn, bigExp, decodeEvents } = require('@aragon/contract-helpers-test')
const { assertRevert, assertBn, assertAmountOfEvents, assertEvent } = require('@aragon/contract-helpers-test/src/asserts')

const { DISPUTE_MANAGER_EVENTS, CLOCK_EVENTS } = require('../helpers/utils/events')
const { buildHelper, DEFAULTS, DISPUTE_STATES } = require('../helpers/wrappers/court')
const { ARAGON_COURT_ERRORS, CONTROLLED_ERRORS, DISPUTE_MANAGER_ERRORS, CLOCK_ERRORS } = require('../helpers/utils/errors')

const ERC20 = artifacts.require('ERC20Mock')
const DisputeManager = artifacts.require('DisputeManager')
const CourtClock = artifacts.require('CourtClock')
const Arbitrable = artifacts.require('ArbitrableMock')

contract('DisputeManager', ([_, fakeArbitrable]) => {
  let courtHelper, court, disputeManager, feeToken, arbitrable

  const termDuration = bn(ONE_DAY)
  const firstTermStartTime = bn(NEXT_WEEK)
  const jurorFee = bigExp(10, 18)
  const draftFee = bigExp(30, 18)
  const settleFee = bigExp(40, 18)
  const firstRoundJurorsNumber = 5

  beforeEach('create court', async () => {
    courtHelper = buildHelper()
    feeToken = await ERC20.new('Court Fee Token', 'CFT', 18)
    court = await courtHelper.deploy({ firstTermStartTime, termDuration, feeToken, jurorFee, draftFee, settleFee, firstRoundJurorsNumber })
    disputeManager = courtHelper.disputeManager
  })

  beforeEach('mock arbitrable instance', async () => {
    arbitrable = await Arbitrable.new(court.address)
    await courtHelper.subscriptions.mockUpToDate(true)
    const { disputeFees } = await courtHelper.getDisputeFees()
    await courtHelper.mintFeeTokens(arbitrable.address, disputeFees)
  })

  describe('createDispute', () => {
    beforeEach('set timestamp at the beginning of the first term', async () => {
      await courtHelper.setTimestamp(firstTermStartTime)
    })

    context('when the sender is an arbitrable', () => {
      context('when the sender is up-to-date with the subscriptions', () => {
        context('when the given rulings is valid', () => {
          const possibleRulings = 2
          const metadata = '0xabcdef'

          const itHandlesDisputesCreationProperly = expectedTermTransitions => {
            context('when the creator approves enough fee tokens', () => {
              let draftTermId, currentTermId

              beforeEach('compute draft term ID', async () => {
                currentTermId = await court.getCurrentTermId()
                draftTermId = currentTermId.add(DEFAULTS.evidenceTerms)
              })

              it('creates a new dispute', async () => {
                const receipt = await arbitrable.createDispute(possibleRulings, metadata)

                const logs = decodeEvents(receipt, DisputeManager.abi, DISPUTE_MANAGER_EVENTS.NEW_DISPUTE)
                assertAmountOfEvents({ logs }, DISPUTE_MANAGER_EVENTS.NEW_DISPUTE)
                assertEvent({ logs }, DISPUTE_MANAGER_EVENTS.NEW_DISPUTE, { expectedArgs: { disputeId: 0, subject: arbitrable.address, draftTermId, jurorsNumber: firstRoundJurorsNumber, metadata } })

                const { subject, possibleRulings: rulings, state, finalRuling, createTermId } = await courtHelper.getDispute(0)
                assert.equal(subject, arbitrable.address, 'dispute subject does not match')
                assertBn(state, DISPUTE_STATES.PRE_DRAFT, 'dispute state does not match')
                assertBn(rulings, possibleRulings, 'dispute possible rulings do not match')
                assertBn(finalRuling, 0, 'dispute final ruling does not match')
                assertBn(createTermId, currentTermId, 'dispute create term ID does not match')
              })

              it('creates a new adjudication round', async () => {
                // move forward to the term before the desired start one for the dispute
                await arbitrable.createDispute(possibleRulings, metadata)

                const { draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, jurorFees, settledPenalties, collectedTokens } = await courtHelper.getRound(0, 0)

                assertBn(draftTerm, draftTermId, 'round draft term does not match')
                assertBn(delayedTerms, 0, 'round delay term does not match')
                assertBn(roundJurorsNumber, firstRoundJurorsNumber, 'round jurors number does not match')
                assertBn(selectedJurors, 0, 'round selected jurors number does not match')
                assertBn(jurorFees, courtHelper.jurorFee.mul(bn(firstRoundJurorsNumber)), 'round juror fees do not match')
                assertBn(collectedTokens, 0, 'round collected tokens should be zero')
                assert.equal(settledPenalties, false, 'round penalties should not be settled')
              })

              it('transfers fees to the dispute manager', async () => {
                const { disputeFees: expectedDisputeDeposit } = await courtHelper.getDisputeFees()
                const previousDisputeManagerBalance = await feeToken.balanceOf(disputeManager.address)
                const previousTreasuryBalance = await feeToken.balanceOf(courtHelper.treasury.address)
                const previousArbitrableBalance = await feeToken.balanceOf(arbitrable.address)

                await arbitrable.createDispute(possibleRulings, metadata)

                const currentDisputeManagerBalance = await feeToken.balanceOf(disputeManager.address)
                assertBn(previousDisputeManagerBalance, currentDisputeManagerBalance, 'dispute manager balances do not match')

                const currentTreasuryBalance = await feeToken.balanceOf(courtHelper.treasury.address)
                assertBn(previousTreasuryBalance.add(expectedDisputeDeposit), currentTreasuryBalance, 'treasury balances do not match')

                const currentArbitrableBalance = await feeToken.balanceOf(arbitrable.address)
                assertBn(previousArbitrableBalance.sub(expectedDisputeDeposit), currentArbitrableBalance, 'arbitrable balances do not match')
              })

              it(`transitions ${expectedTermTransitions} terms`, async () => {
                const previousTermId = await court.getLastEnsuredTermId()

                const receipt = await arbitrable.createDispute(possibleRulings, metadata)

                const logs = decodeEvents(receipt, CourtClock.abi, CLOCK_EVENTS.HEARTBEAT)
                assertAmountOfEvents({ logs }, CLOCK_EVENTS.HEARTBEAT, { expectedAmount: expectedTermTransitions })

                const currentTermId = await court.getLastEnsuredTermId()
                assertBn(previousTermId.add(bn(expectedTermTransitions)), currentTermId, 'term id does not match')
              })
            })

            context('when the creator does not have enough fee tokens', () => {
              beforeEach('create a previous dispute to spend fee tokens', async () => {
                await arbitrable.createDispute(possibleRulings, metadata)
              })

              it('reverts', async () => {
                await assertRevert(arbitrable.createDispute(possibleRulings, metadata), DISPUTE_MANAGER_ERRORS.DEPOSIT_FAILED)
              })
            })
          }

          context('when the term is up-to-date', () => {
            const expectedTermTransitions = 0

            beforeEach('move right before the desired draft term', async () => {
              await court.heartbeat(1)
            })

            itHandlesDisputesCreationProperly(expectedTermTransitions)
          })

          context('when the term is outdated by one term', () => {
            const expectedTermTransitions = 1

            itHandlesDisputesCreationProperly(expectedTermTransitions)
          })

          context('when the term is outdated by more than one term', () => {
            beforeEach('set timestamp two terms after the first term', async () => {
              await courtHelper.setTimestamp(firstTermStartTime.add(termDuration.mul(bn(2))))
            })

            it('reverts', async () => {
              await assertRevert(arbitrable.createDispute(possibleRulings, metadata), CLOCK_ERRORS.TOO_MANY_TRANSITIONS)
            })
          })
        })

        context('when the given rulings is not valid', () => {
          it('reverts', async () => {
            await assertRevert(arbitrable.createDispute(0, '0x'), DISPUTE_MANAGER_ERRORS.INVALID_RULING_OPTIONS)
            await assertRevert(arbitrable.createDispute(1, '0x'), DISPUTE_MANAGER_ERRORS.INVALID_RULING_OPTIONS)
            await assertRevert(arbitrable.createDispute(3, '0x'), DISPUTE_MANAGER_ERRORS.INVALID_RULING_OPTIONS)
          })
        })
      })

      context('when the sender is outdated with the subscriptions', () => {
        beforeEach('expire subscriptions', async () => {
          await courtHelper.subscriptions.mockUpToDate(false)
        })

        it('reverts', async () => {
          await assertRevert(arbitrable.createDispute(2, '0x'), ARAGON_COURT_ERRORS.SUBSCRIPTION_NOT_PAID)
        })
      })
    })

    context('when the sender is not an arbitrable', () => {
      it('creates a dispute', async () => {
        const { disputeFees } = await courtHelper.getDisputeFees()
        await courtHelper.mintFeeTokens(fakeArbitrable, disputeFees)
        await feeToken.approve(disputeManager.address, disputeFees, { from: fakeArbitrable })

        const receipt = await court.createDispute(2, '0xabcd', { from: fakeArbitrable })

        assertAmountOfEvents(receipt, DISPUTE_MANAGER_EVENTS.NEW_DISPUTE, { decodeForAbi: DisputeManager.abi })
        assertEvent(receipt, DISPUTE_MANAGER_EVENTS.NEW_DISPUTE, { expectedArgs: { disputeId: 0, subject: fakeArbitrable, metadata: '0xabcd' }, decodeForAbi: DisputeManager.abi })
      })
    })

    context('when trying to call the disputes manager directly', () => {
      it('reverts', async () => {
        await assertRevert(disputeManager.createDispute(arbitrable.address, 2, '0x'), CONTROLLED_ERRORS.SENDER_NOT_CONTROLLER)
      })
    })
  })

  describe('getDispute', () => {
    context('when the dispute exists', async () => {
      let currentTermId
      const possibleRulings = 2
      const metadata = '0xabcdef'

      beforeEach('create dispute', async () => {
        currentTermId = await court.getCurrentTermId()
        await arbitrable.createDispute(possibleRulings, metadata)
      })

      it('returns the requested dispute', async () => {
        const { subject, possibleRulings: rulings, state, finalRuling, createTermId } = await courtHelper.getDispute(0)

        assert.equal(subject, arbitrable.address, 'dispute subject does not match')
        assertBn(state, DISPUTE_STATES.PRE_DRAFT, 'dispute state does not match')
        assertBn(rulings, possibleRulings, 'dispute possible rulings do not match')
        assertBn(finalRuling, 0, 'dispute final ruling does not match')
        assertBn(createTermId, currentTermId, 'dispute create term ID does not match')
      })
    })

    context('when the given dispute does not exist', () => {
      it('reverts', async () => {
        await assertRevert(disputeManager.getDispute(0), DISPUTE_MANAGER_ERRORS.DISPUTE_DOES_NOT_EXIST)
      })
    })
  })

  describe('getRound', () => {
    context('when the dispute exists', async () => {
      let draftTermId
      const possibleRulings = 2
      const metadata = '0xabcdef'

      beforeEach('create dispute', async () => {
        const currentTermId = await court.getCurrentTermId()
        draftTermId = currentTermId.add(DEFAULTS.evidenceTerms)
        await arbitrable.createDispute(possibleRulings, metadata)
      })

      context('when the given round is valid', async () => {
        it('returns the requested round', async () => {
          const { draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, jurorFees, settledPenalties, collectedTokens } = await courtHelper.getRound(0, 0)

          assertBn(draftTerm, draftTermId, 'round draft term does not match')
          assertBn(delayedTerms, 0, 'round delay term does not match')
          assertBn(roundJurorsNumber, firstRoundJurorsNumber, 'round jurors number does not match')
          assertBn(selectedJurors, 0, 'round selected jurors number does not match')
          assertBn(jurorFees, courtHelper.jurorFee.mul(bn(firstRoundJurorsNumber)), 'round juror fees do not match')
          assertBn(collectedTokens, 0, 'round collected tokens should be zero')
          assert.equal(settledPenalties, false, 'round penalties should not be settled')
        })
      })

      context('when the given round is not valid', async () => {
        it('reverts', async () => {
          await assertRevert(disputeManager.getRound(0, 1), DISPUTE_MANAGER_ERRORS.ROUND_DOES_NOT_EXIST)
        })
      })
    })

    context('when the given dispute does not exist', () => {
      it('reverts', async () => {
        await assertRevert(disputeManager.getRound(0, 0), DISPUTE_MANAGER_ERRORS.DISPUTE_DOES_NOT_EXIST)
      })
    })
  })
})
