/**
 * The Crowd4Test legal documents — the terms and conditions and the privacy
 * policy — transcribed from the copy the client supplied on 2026-09-14.
 * Rendered at /legal/terms and /legal/privacy by `components/legal/`.
 *
 * ── TRANSCRIBED, NOT WRITTEN
 *
 * Unlike every other module in this folder this is not marketing copy and does
 * not come from `design-handoff/design/content.md`. These are the agreements
 * people accept when they sign up, so every block below is the client's
 * wording character for character — their spelling, their punctuation, their
 * mix of straight and typographic quotes. DO NOT edit a clause to improve it.
 * A legal document is changed by the client, then re-transcribed here.
 *
 * ── THE SIX CORRECTIONS THE CLIENT AUTHORISED, 2026-09-14
 *
 * These are the ONLY places the text diverges from the supplied copy. Each was
 * flagged to the client first and approved; nothing here was changed on this
 * file's own judgement, and nothing else was touched.
 *
 *   privacy 2.2   "the oprimes API" → "the crowd4test API", and "their oprimes
 *                 account" → "their crowd4test account". The policy had been
 *                 adapted from another platform's and kept its name.
 *   privacy 3     "the personal information oprimes holds" → "crowd4test holds"
 *   privacy 1.2.4 renumbered from 1.1.4, which 1.1.3 already holds — 1.2.2
 *                 cites "(1.1.4)" meaning that earlier section
 *   terms 1.24    "will store is copy" → "will store its copy"
 *   terms 2.6     "Crow4Test" → "Crowd4Test"
 *   terms 2.7     "Crow4Test" → "Crowd4Test"
 *   terms 2.16    "wordwide" → "worldwide"
 *
 * The lower-case "crowd4test" in the privacy corrections is deliberate: that
 * document writes the name in lower case throughout, including its opening
 * line, while the terms write it "Crowd4Test". Each was matched to its own.
 *
 * ── WHAT THE FORMATTING ADDS
 *
 * The terms arrived as three runs of unnumbered paragraphs under three ALL
 * CAPS headings. Their clause numbers (1.1, 2.4, …) and sentence-case part
 * titles are this file's only additions; they let a clause be linked and
 * cited, which an agreement needs and a wall of paragraphs cannot do. The
 * privacy policy already carried its own numbering and that is preserved
 * exactly, errors included. No text was added, removed, merged or reordered
 * in either document.
 */

export type LegalBlock =
  { kind: 'paragraph'; text: string } | { kind: 'list'; ordered: boolean; items: readonly string[] }

export interface LegalSection {
  /** URL fragment — `/legal/terms#general`. Stable; never renumber one. */
  id: string
  /** '1', '1.2', '1.2.3'. The number of segments is the heading depth. */
  number: string
  /** Absent on the terms clauses: the source gives those no headings. */
  title?: string
  blocks: readonly LegalBlock[]
}

export interface LegalDocument {
  /** The registered route it renders at; that route owns the title and lede. */
  slug: string
  /** Anything before the first numbered section. */
  preamble?: readonly LegalBlock[]
  sections: readonly LegalSection[]
}

export const TERMS_AND_CONDITIONS: LegalDocument = {
  slug: '/legal/terms',
  sections: [
    // ── GENERAL TERMS AND CONDITIONS
    {
      id: 'general',
      number: '1',
      title: 'General terms and conditions',
      blocks: [],
    },
    {
      id: '1-1',
      number: '1.1',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The minimum age of acceptance of the Terms and Conditions contained herewith in this document is 18 years of age.',
        },
      ],
    },
    {
      id: '1-2',
      number: '1.2',
      blocks: [
        {
          kind: 'paragraph',
          text: 'As a customer, you must possess the authority to accept the Terms and Conditions on behalf of a company.',
        },
      ],
    },
    {
      id: '1-3',
      number: '1.3',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Crowd4Test, is a ‘Company’ as defined by the laws of the nation of India. (‘Crowd4Test’) offers an online service whereby Customers (‘Customer, Customers’) who are the makers of mobile/web/desktop Applications can have these services (‘Applications’) tested by people (‘Testers) who have registered with the company (Crowd4Test) for use of the said service.',
        },
      ],
    },
    {
      id: '1-4',
      number: '1.4',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Password and account details must at all times be kept confidential and must not be shared with anyone. You as a tester are held responsible for all activities and orders that take place on the account or get submitted under its password. If you suspect that your account has been compromised; or that someone else has knowledge of your password, you should notify Crowd4Test immediately. Any loss resulting from failure to comply with the security obligation will not be the liability of Crowd4Test.',
        },
      ],
    },
    {
      id: '1-5',
      number: '1.5',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Service in this instance is a term that will apply to the online testing service, provided by Crowd4Test, which enables Customers to have their Applications tested for bugs or flaws by Tester or Testers.',
        },
      ],
    },
    {
      id: '1-6',
      number: '1.6',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Territory or territories are implied and mean all countries of the world.',
        },
      ],
    },
    {
      id: '1-7',
      number: '1.7',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A tester’s services from this point forth will be referred to as ‘the Testing services’.',
        },
      ],
    },
    {
      id: '1-8',
      number: '1.8',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The use of any product or service cannot be advocated, advertised or promoted when using the Service and/or the Crowd4Test Website.',
        },
      ],
    },
    {
      id: '1-9',
      number: '1.9',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You must refrain from collecting any third party content or information or otherwise access the Service and/or the Crowd4Test Website, using automated means (such as bots, robots, spiders, or scrapers);',
        },
      ],
    },
    {
      id: '1-10',
      number: '1.10',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We have a strict policy against SPAM and distribution or posting of any material viewed as spam such as unsolicited, or bulk electronic communications, chain letters, or pyramid schemes would be dealt with as deemed fit by the company',
        },
      ],
    },
    {
      id: '1-11',
      number: '1.11',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Any attempt at disrupting the service or introducing viruses, trojan horses, spyware, cancel bots or other malicious code into the Service and/or the Crowd4Test Website will also be dealt with as a threat to the Company and dealt with to the fullest extent of the law.',
        },
      ],
    },
    {
      id: '1-12',
      number: '1.12',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You will have to respect the privacy of both the company and its clients. With this in mind, you are not to access, tamper with, or use non-public areas of the Service and/or the Crowd4Test Website, the computer systems of Crowd4Test, or the technical delivery systems of its providers.',
        },
      ],
    },
    {
      id: '1-13',
      number: '1.13',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Probing, scanning and testing the vulnerability of any system or network is strictly prohibited. As is the breaching or circumventing of any security or authentication measures.',
        },
      ],
    },
    {
      id: '1-14',
      number: '1.14',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Forging any TCP/IP packet header or any part of the header information in any email or posting is strictly and expressly forbidden. Sending out altered deceptive or false source identifying information using the Service and/or the Crowd4Test website is likewise expressly forbidden.',
        },
      ],
    },
    {
      id: '1-15',
      number: '1.15',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Bullying, intimidation and harassment of any kind to a third party is unacceptable and will not be tolerated.',
        },
      ],
    },
    {
      id: '1-16',
      number: '1.16',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Any illegal, unlawful, misleading, malicious or discriminatory activities using the Service or the Crowd4Test Website are strictly prohibited.',
        },
      ],
    },
    {
      id: '1-17',
      number: '1.17',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Any practice that would disable, overburden, or impair the proper working of the Service will not be tolerated.',
        },
      ],
    },
    {
      id: '1-18',
      number: '1.18',
      blocks: [
        {
          kind: 'paragraph',
          text: 'If there ever exists a confusion, ambiguity or any sort of discrepancy between the provisions mentioned in this agreement and any of the information contained in the pages of the Crowd4Test website; the provisions of this agreement will take precedence.',
        },
      ],
    },
    {
      id: '1-19',
      number: '1.19',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The Service and the Company Crowd4Test website will always be provided in an ‘AS IS’ condition, this means that Crowd4Test expressly disclaims any and all warranties, whether actual or assumed, including but not limited to, warranties of merchantability, fitness for a particular purpose, title, non-infringement (non-interference) and any and all warranties arising from the course of dealing and usage of the trade, that the Service will meet your requirements, that the Service will be always available, accessible, uninterrupted, be free of human errors (from time to time), timely, secure, or operate without occasional glitches, or errors as to the results obtained as ‘output’ from the operation, use or other exploitation of the Service and as to the accuracy, infallibility or reliability of any information obtained from the Service or the Crowd4Test website.',
        },
      ],
    },
    {
      id: '1-20',
      number: '1.20',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This agreement shall be governed by, construed in and interpreted using the laws of the sovereign nation of India. Disputes arising out of, in connection to or as a consequence of this agreement, shall be settled by the district court of Bengaluru, India as first instance, as it will have jurisdiction in all matters.',
        },
      ],
    },
    {
      id: '1-21',
      number: '1.21',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Crowd4Test reserves the right to transfer its rights and obligations that may occur as a result of this Agreement, in whole, or any part thereof, to any third party without your prior written consent.',
        },
      ],
    },
    {
      id: '1-22',
      number: '1.22',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The ‘Term’ of this ‘Agreement’ shall take effect at the date hereof and shall be held valid or in force until terminated by any of the parties. This is of course given that the other party’s notice of termination has been submitted no less than 30 days in advance. Notwithstanding the foregoing, in the case that the Company, Crowd4Test terminates this agreement before the expiry of an on-going testing project cycle; the termination shall not be effective, until the obligations of the parties in connection with the on-going testing project, i.e. in this case the Tester have been fulfilled.',
        },
      ],
    },
    {
      id: '1-23',
      number: '1.23',
      blocks: [
        {
          kind: 'paragraph',
          text: 'If any proviso of this agreement or its application be declared null and void, or unenforceable for any reason whatsoever; in whole or in part for any reason whatsoever, the parties involved shall amend this agreement in order to give effect, insofar as possible that the intent of this agreement. If for whatever reason the parties fail to amend this agreement, the provision that has been deemed void, invalid or unenforceable, shall be deleted and the remaining provisos (agreed upon in intent and purpose by both parties) will continue with full force and effect.',
        },
      ],
    },
    {
      id: '1-24',
      number: '1.24',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The execution of this contract is in the digital form and we (Crowd4Test) will store its copy in such form, properly signed.',
        },
      ],
    },
    // ── TERMS AND CONDITIONS BETWEEN CUSTOMER AND CROWD4TEST
    {
      id: 'customer-and-crowd4test',
      number: '2',
      title: 'Terms and conditions between customer and Crowd4Test',
      blocks: [],
    },
    {
      id: '2-1',
      number: '2.1',
      blocks: [
        {
          kind: 'paragraph',
          text: 'These ‘Terms and Conditions’, including any and all information on the Crowd4Test website constitutes ‘This Agreement’, and governs your use of the Testing Service as well as your legal relationship with Crowd4Test. You enter into this agreement of your own free will and in your capacity as a ‘Customer’; which implies that you are a developer or producer of Applications, or in your capacity as the holder to rights to said Applications. You will hereinafter be referred to as ‘Customer’.',
        },
      ],
    },
    {
      id: '2-2',
      number: '2.2',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In accordance with the terms and conditions expounded in and set out in this Agreement, Crowd4Test will make the service available to Customers and Testers in the Territory. This Agreement also grants Customer(s) a non-exclusive, non-transferable and non-assignable license to use the Service, in accordance to the provisos of this agreement.',
        },
      ],
    },
    {
      id: '2-3',
      number: '2.3',
      blocks: [
        {
          kind: 'paragraph',
          text: 'When subscribing to, availing of, or using the Service, the Customer may, in regard to each testing service project, decide upon the length/duration of the testing project cycle (a testing project cycle by definition, however cannot be shorter than 3 or longer than 21 days), as well as the fee to be paid in lieu of or in consideration of the Testing Services (defined as ‘The Testing Fee’). All Testers are selected by Crowd4Test. Crowd4Test however does not guarantee the participation of a ‘minimum number’ of Testers or the quality and credentials of any particular, individual Tester.',
        },
      ],
    },
    {
      id: '2-4',
      number: '2.4',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Unless specified previously or expressly provided, Crowd4Test makes no representations or warranties for the quality of the Testing Services provided by the Testers. No guarantees are given that any or all of the Test Artifacts (including, but not limited to bugs, test cases, test scripts or any other artifacts implemented) in connection with an Application will be found, diagnosed or resolved as a result of engaging, hiring or working with Testers through the Service.',
        },
      ],
    },
    {
      id: '2-5',
      number: '2.5',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The mechanism of ‘delivery’ applied will be as follows. The Testers will deliver the results of the test to Crowd4Test within the stipulated expiry of the testing project. Thereafter within 24 additional hours, Crowd4Test will make the same, including the Test Artifacts available to the Customer online, whereby the Test Artifacts will be deemed as delivered to the Customer.',
        },
      ],
    },
    {
      id: '2-6',
      number: '2.6',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In case of the satisfactory completion of the Testing Services, i.e. if the Testing Services are performed in a manner that the results are in conformity with the testing model stipulated in the project description, Crowd4Test and the Testers shall have deemed to have fulfilled their obligations in regards with the Testing Services. If there are any deviations or shortcomings in relation to the testing model or methodology, the Testers will be given the opportunity to remedy them. For the above proviso to hold force however, the Customer will have to notify Crowd4Test within a stipulated period of 10 days following their receipt of the Testing Artifacts. Failure to comply with this proviso will result in Crowd4Test and the Testers being deemed as having fulfilled their contractual obligations applicable to the Testing Services, regardless of the deviations or shortcomings.',
        },
      ],
    },
    {
      id: '2-7',
      number: '2.7',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In the event of the Customer(s) notifying Crowd4Test of any shortcomings or deviations in a timely manner i.e. within the stipulated 10 day period, Crowd4Test will remedy, or procure the remedy of, such deviations or shortcomings. When remedied, Crowd4Test and the Testers will be deemed to have fulfilled their obligations with regards to the applicable Testing Services. If however, the shortcomings or deviations are not remedied within 10 days, Crowd4Test and the Testers will be deemed to have not fulfilled their obligations with regards to the applicable Testing Services or with regards to the individual test parameters which are incorrect. In such cases, Customers will have no obligation to pay the agreed Testing Fee and Service Fee (see below) as regards the tests which are incorrect. With respect to the legal relationship (read right of redressal), the non-payment of Service Fee will be the only remedy (read compensation/financial liability) of such deviations or shortcomings.',
        },
      ],
    },
    {
      id: '2-8',
      number: '2.8',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Crowd4Test functions as nothing more than an intermediary or connection point between Customers and Testers. The Customer engages the Testers (in its own name and in its own behalf) with all matters pertaining to the services provided by the Testers in connection to the Testing Services, as such each test shall be governed by the following set of conditions (read Terms and Conditions between Customer and Testers). For the delineation of responsibility and avoidance of any ambiguity, the contracting parties with regards to the Testing Services are the Customers (Producers of the Application) and the Testers (Testing Agents).',
        },
      ],
    },
    {
      id: '2-9',
      number: '2.9',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Crowd4Test and the Customer(s) are to remain independent and distinct from one another. Neither party, shall have any authority whatsoever to enter into agreements or other accept any obligations, liabilities or responsibility on behalf of the other party, unless expressly agreed to (by both the concerned parties) in writing and independently in each individual case. Nothing contained in this Agreement, shall be construed as or is tantamount to constituency of an agency, of employment, company or joint venture of any kind between both parties.',
        },
      ],
    },
    {
      id: '2-10',
      number: '2.10',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Except in relation to Testing Services, the Customer is expressly forbidden from making any kind of contact (written or oral communication , direct contact)or engaging in any transaction commercial or otherwise, with the individual Tester or Testers, whether through the Service and/or the Crowd4Test website or otherwise. The Customer(s) agree to withhold contact information ( i.e. refrain from posting their email address, phone number or any other mode of contact) outside of the Crowd4Test website or giving any of the aforementioned information to the Testers.',
        },
      ],
    },
    {
      id: '2-11',
      number: '2.11',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Crowd4Test will render a detailed account of the Testing Fee to the Testers, through which payment to each and every Tester, entitled to a Testing Fee will be made upon an express request by the Tester if and when all the Testing Fees due to the individual Tester exceeds US$ 50 (fifty).',
        },
      ],
    },
    {
      id: '2-12',
      number: '2.12',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Crowd4Test will keep all Testing Fees paid in an Escrow Account, independent of its own funds and may only handle and use these funds in accordance with the provisions of this agreement.',
        },
      ],
    },
    {
      id: '2-13',
      number: '2.13',
      blocks: [
        {
          kind: 'paragraph',
          text: 'It is the Customer(s’) responsibility to compensate Crowd4Test, for any and all damages suffered by Crowd4Test arising out of, or resulting from any breach by the Customer of a provision of this agreement. These damages or reparations shall be payable with or without proof of or intent of negligence. In addition to this right to receive reparations/damages, Crowd4Test reserves the right, (shall be entitled to) terminate this agreement with immediate effect, or suspend Customer(s’) access to the Service in the case of any breach/negligence on the Customer(s’) part of the provisions of this agreement. In such a case, if Crowd4Test decides to terminate this Agreement or suspend Customer(s’) access to the Service for any reasons stated or set out in this sub-clause, Crowd4Test will not have any liability (will be excused of any responsibility) to the Customer.',
        },
      ],
    },
    {
      id: '2-14',
      number: '2.14',
      blocks: [
        {
          kind: 'paragraph',
          text: 'All right, intent, title and intellectual property, in interest of and pertaining to the Service remains in entirety the exclusive property of Crowd4Test. This Agreement in no part entitles the Customer to use such materials other than as provided for in hereof, nor shall this Agreement bestow upon the Customer the right to use Crowd4Test’s name or any of Crowd4Test’s trademarks, copyrighted material, logos, domain names or other distinctive and proprietary brand features.',
        },
      ],
    },
    {
      id: '2-15',
      number: '2.15',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Unless specified in writing or agreed to in principle by Crowd4Test, Crowd4Test may display Customer(s’) company name, logo and public description on the Crowd4Test website or in other marketing materials or paraphernalia.',
        },
      ],
    },
    {
      id: '2-16',
      number: '2.16',
      blocks: [
        {
          kind: 'paragraph',
          text: 'By submitting content to the Service and/or the Crowd4Test website (including but not limited to, information submitted while creating your account, posting a profile, posting the Application(s), posting a testing project or sending messages through or to the Crowd4Test website), the Customer(s) hereby grant Crowd4Test a universal, worldwide, perpetual, irrevocable, royalty-free license to copy and use such content in the Service and on the Crowd4Test website for the purpose of this agreement.',
        },
      ],
    },
    {
      id: '2-17',
      number: '2.17',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Crowd4Test reserves the exclusive right to add services to the Crowd4Test website and/or to modify/change/delete or in any way alter the nature of such services without prior notice to the Customer(s).',
        },
      ],
    },
    {
      id: '2-18',
      number: '2.18',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Crowd4Test reserves the sole right to make amendments/ addendums/caveats to this Agreement at any time. The Customer(s) will be notified by Crowd4Test of its intent to make such amendments/addendums/caveats to this Agreement, by e-mail or when the Customer(s) next accesses its/their account. If the Customer(s) should notify Crowd4Test that it/they cannot or will not accept such amendments/addendums/caveats, Crowd4Test reserves the right to/will be entitled to terminate this Agreement, either with immediate effect or as per Crowd4Test’s discretion. Else the Customer(s’) use of the Service will be subjected to the amended agreement.',
        },
      ],
    },
    // ── TERMS AND CONDITIONS BETWEEN CUSTOMER AND TESTER
    {
      id: 'customer-and-tester',
      number: '3',
      title: 'Terms and conditions between customer and tester',
      blocks: [],
    },
    {
      id: '3-1',
      number: '3.1',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You enter into this agreement in one of two capacities, either as a Customer; defined as a producer of Applications, or as a Tester; defined as Tester of said Applications. If you enter into this agreement as a ‘Customer’ you will hereinafter be referred to as a Customer, and if you enter this agreement as a ‘Tester’ you will hereinafter be referred to as ‘Tester’.',
        },
      ],
    },
    {
      id: '3-2',
      number: '3.2',
      blocks: [
        {
          kind: 'paragraph',
          text: 'With regards to each ‘Application Testing’ project that is offered by the Customer and accepted by an individual Tester, the Customer engages the Tester(s) (in their own name and behalf) to perform the Testing Services stipulated in the Project Description (‘Testing Services’). Each and every independent testing project will be governed by these terms and conditions.',
        },
      ],
    },
    {
      id: '3-3',
      number: '3.3',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Let it be understood, that a Tester will be an independent contractor to and not an employee of the Customer. Nothing mentioned in this document, implicitly or explicitly shall constitute or be deemed to constitute an agency, employment, company, or joint venture of any sort between both the parties.',
        },
      ],
    },
    {
      id: '3-4',
      number: '3.4',
      blocks: [
        {
          kind: 'paragraph',
          text: 'It will be considered the Tester’s responsibility to manage, plan details and performance of the Testing Services. The Tester also assumes responsibility of providing and maintaining all necessary computer equipment and internet connectivity, necessary for the performance of the Testing Services. It is in no way the Customer’s prerogative, responsibility or obligation to provide any training, technical and/or administrative support or any other assistance in connection with the Tester’s duties hereunder.',
        },
      ],
    },
    {
      id: '3-5',
      number: '3.5',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In the interest of ethics and fair play it is the Tester’s moral obligation to certify that he does not work for or is in any way affiliated with any competitor of the Customer.',
        },
      ],
    },
    {
      id: '3-6',
      number: '3.6',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The only use of an Application by a Tester is for the sole purpose of testing and reporting bugs and other Test Artifacts in connection with the Testing Services. The Tester must abide by this proviso and must represent that he/she shall not, under any circumstances, copy, or attempt to copy by any means, reverse engineer, take screenshots, video captures of, or otherwise store the Applications (unless such copies are mandated or are made in connection with the downloading of the Applications in connection with the Testing Services). The Tester agrees non-disclosure of any Applications to other Testers, or any third parties whether in person or through any digital media including and not limited to, emails, blogs, news sources, social networks, or any other form of communication to the public. The stipulated terms in the foregoing will also be applicable to any concepts, source code, ideas and any other conceptual or intellectual property in connection with the Applications, regardless of whether such ideas, concepts and source code is protected by force of law or not.',
        },
      ],
    },
    {
      id: '3-7',
      number: '3.7',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The Customer is the owner of the Application and as such retains, controls and reserves all rights, titles, interest and intellectual property resulting from said Application. This right is inclusive and not limited to software, images, illustrations, icons, designs, logotypes, fonts, names, concepts and all other material contained therein. All copyright, trademark, design and patent rights or any other intellectual property rights with relation to the Application and all it entails are owned by the Customer and protected to the fullest extent of the law.',
        },
      ],
    },
    {
      id: '3-8',
      number: '3.8',
      blocks: [
        {
          kind: 'paragraph',
          text: 'After completion of the Testing Service, the Tester agrees to delete all copies of the Application(s) or return the same in his possession.',
        },
      ],
    },
    {
      id: '3-9',
      number: '3.9',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The Tester indemnifies and will hold to no suit the Customer or any of its affiliates and business partners (including but not limited to, any directors, members, employees and other representatives) from and against any and all claims, losses, damages, liabilities, costs and expenses, including but not limited to, legal expenses and reasonable counsel fees, arising out of any breach or alleged breach by Tester of the above provisos.',
        },
      ],
    },
    {
      id: '3-10',
      number: '3.10',
      blocks: [
        {
          kind: 'paragraph',
          text: 'When using the Testing Service, the Tester will have access to new and developing Applications and software and information about companies that he/she (the Tester) is evaluating the Applications and/or softwares for. The Tester hereby acknowledges that he/she has an absolute responsibility towards maintaining confidentiality of the Applications or software, and respect the intellectual right and property of the Customer. This intellectual property includes all software, images, illustrations, icons, designs, logotypes, names, concepts, ideas and all other material contained therein, and all other information Tester acquire, learn of, or otherwise have awareness of as a result of its use of the Testing Services.',
        },
      ],
    },
    {
      id: '3-11',
      number: '3.11',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In the interest of ethics and fair play the Tester hereby certifies that he or she may not work for, or be affiliated in any way to any competitor of the Customer.',
        },
      ],
    },
    {
      id: '3-12',
      number: '3.12',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The Tester and Customer hereby pledge to compensate each other for any and all damages suffered by either party, including any losses arising out of breach by either Tester or Customer of a provision of this agreement. Damages are payable, with or without proof of wilful intent or negligence.',
        },
      ],
    },
  ],
}

export const PRIVACY_POLICY: LegalDocument = {
  slug: '/legal/privacy',
  preamble: [
    {
      kind: 'paragraph',
      text: 'Please go through our privacy policy and understand better what are the guidelines that we follow',
    },
    {
      kind: 'paragraph',
      text: 'crowd4test ("we", "us", "our") is dedicated to protecting the privacy and personal information of our users ("you", "your"). This Privacy Policy outlines our practices regarding the collection, use, and disclosure of personal information when you use our services. It also describes how we process personal data for individuals in the European Union (EU) in accordance with the General Data Protection Regulation (GDPR). We encourage you to review our website regularly for updates to this policy. "Personal Information" refers to information about an identified or reasonably identifiable individual. This Privacy Policy applies to personal information collected and/or held by crowd4test.',
    },
  ],
  sections: [
    {
      id: 'personal-information-we-collect',
      number: '1',
      title: 'Personal Information we Collect and hold',
      blocks: [],
    },
    {
      id: 'type-of-personal-information',
      number: '1.1',
      title: 'Type of Personal Information',
      blocks: [],
    },
    {
      id: 'information-obtained-for-interaction',
      number: '1.1.1',
      title: 'Information obtained for Interaction Purpose',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We collect your personal information in order to provide our products, services, and customer support, which are provided through many platforms including but not limited to: websites, phone apps, emails, and telephones. The specific platform and product, service, or support you interact with may affect the personal data we collect.',
        },
      ],
    },
    {
      id: 'non-personal-information',
      number: '1.1.2',
      title: 'Non-Personal Information linked with existing Personal Information',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Not all information requested, collected, and processed by us is “Personal Information” as it does not identify you as a specific natural person. This will include majority of “User Generated Content” that you provide us with the intention of sharing with other users. Such “Non-Personal Information” is not covered by this privacy policy. However, as non-personal information may be used in aggregate or be linked with existing personal information; when in this form it will be treated as personal information. As such, this privacy policy will list both types of information for the sake of transparency.',
        },
      ],
    },
    {
      id: 'information-not-intended-for-collection',
      number: '1.1.3',
      title: 'Personal Information not intended for collection of particular types of information',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In some situation you may provide us with personal information without us asking for it, or through means not intended for the collection of particular types of information. Whilst we may take reasonable steps to protect this data, you will have bypassed our systems, processes, and control and thus the information provided will not be governed by this privacy policy.',
        },
      ],
    },
    {
      id: 'information-over-platforms-outside-our-control',
      number: '1.1.4',
      title: 'Information provided over platforms outside our control',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In some situations you may provide us personal information over platforms that are outside our control; for example through social media or forums. Whilst any information collected by us is governed by this Privacy Policy, the platform by which it was communicated will be governed by its own Privacy Policy.',
        },
      ],
    },
    {
      id: 'how-we-collect-personal-information',
      number: '1.2',
      title: 'How we collect personal information',
      blocks: [],
    },
    {
      id: 'information-that-you-give-us',
      number: '1.2.1',
      title: 'Information that you specifically give us',
      blocks: [
        {
          kind: 'paragraph',
          text: 'While you use our products, services and customer support, you may be asked to provide certain types of personal information. This might happen through our website, applications, emails, online chat systems, telephone, paper forms, or in-person meetings. We may request, collect, or process the following information:',
        },
        {
          kind: 'list',
          ordered: true,
          items: [
            'Account Details – username,password,profile picture.',
            'Contact Details – email address,phone number.',
            'Location Details – physical address, billing address, timezone.',
            'Identity Details – full name, proof of identity (e.g. drivers licence, passport), proof of address (e.g. utility bill), photograph.',
            'Financial Information – credit card details, wire transfer details, payment processor details (e.g. instamojo, paypal), tax numbers.',
            'User Generated Content – project descriptions and attachments, payout description, user profiles, user reviews, contest descriptions and attachment, user messages etc.',
          ],
        },
      ],
    },
    {
      id: 'information-we-collect-from-others',
      number: '1.2.2',
      title: 'Information that we collect from others',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You might give us permission to connect to your account on other platforms to collect personal information. (1.1.4) This includes but is not limited to Facebook, LinkedIn, and Google. Information collected will be governed by this Privacy Policy. You can stop us from collecting data from other platforms by removing our access on the other platform or by contacting our support team. Since you have the ability to invite non-users to our platform by providing contact details such as email address, we may collect and store the information to contact the non-user and to prevent abuse of the invite systems. Your payment provider may transmit information about the payment that we may collect or process. In some situations, your personal information may be collected from public sources. We may collect or process the following information:',
        },
        {
          kind: 'list',
          ordered: true,
          items: [
            'Basic Details – username, profile picture.',
            'Contact Details – email address, phone number.',
            'Location Details – Physical Address, billing address, timezone.',
            'Financial Information – payment account details (e.g. paypal email address and physical address), and wire transfer details.',
            'List of contacts – email provider address book.',
            'User Generated Content – user profile.',
          ],
        },
      ],
    },
    {
      id: 'information-we-collect-as-you-use-our-service',
      number: '1.2.3',
      title: 'Information we collect as you use our service',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We maintain records of the interactions we have with you, including the products, services and customer support we have provided. This includes your interactions with our platform such as when you have viewed a page or clicked a button. In order to deliver certain products or services we may passively collect your GPS coordinates, where available from your device. Most modern devices such as smartphones will display a permission request when our platform requests this data. When we are contacted we may collect personal information that is intrinsic to the communication. For example, if we are contacted via email, we will collect the email address used.',
        },
        {
          kind: 'paragraph',
          text: 'We may collect or process the following information:',
        },
        {
          kind: 'list',
          ordered: true,
          items: [
            'Metadata – IP address, computer and connection information, referring web page, standard web log information, language settings, timezone, etc.',
            'Device Information – device identifier, device type, device plugins, hardware capabilities, etc.',
            'Location – GPS position.',
            'Actions – pages viewed, buttons clicked, time spent viewing, search keywords, etc.',
          ],
        },
      ],
    },
    {
      /*
        NUMBERED 1.1.4 IN THE SOURCE, which 1.1.3 already holds. Clause 1.2.2
        cites "(1.1.4)" meaning that earlier section, so this one is the slip;
        it sits after 1.2.3 and belongs to the 1.2 run. Corrected to 1.2.4 on
        the client's instruction, 2026-09-14.
      */
      id: 'links-to-other-sites',
      number: '1.2.4',
      title: 'Links to other sites',
      blocks: [
        {
          kind: 'paragraph',
          text: 'On our website, you will encounter links to third party websites. These links may be from us, or they may appear as content generated by other users. These linked sites are not under our control and thus we are not responsible for their actions. Before providing your personal information via any other website, we advise you to examine the terms and conditions of using that website and its privacy policy.',
        },
      ],
    },
    {
      id: 'when-we-disclose-personal-information',
      number: '2',
      title: 'When we disclose personal information',
      blocks: [],
    },
    {
      id: 'our-third-party-service-providers',
      number: '2.1',
      title: 'Our third party service providers',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Your personal information may be held or processed on our behalf outside India, including ‘in the cloud’, by our third party service providers. Our third party service providers are bound by contract to only use your personal information on our behalf, under our instructions.',
        },
        {
          kind: 'paragraph',
          text: 'Our third party service providers include:',
        },
        {
          kind: 'list',
          ordered: false,
          items: [
            'Cloud hosting, storage, networking and related providers',
            'SMS providers',
            'Payment and banking providers',
            'Marketing and analytics providers',
            'Security providers',
          ],
        },
      ],
    },
    {
      id: 'third-party-applications',
      number: '2.2',
      title: 'Third party applications',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Through the crowd4test API, it is possible for you to grant third party applications access to their crowd4test account. Depending on the permissions that are granted, these applications may be able to access some personal information or do actions on the your behalf. These third party applications are not controlled by us and will be governed by their own privacy policy. You can remove third party applications from accessing your data through your settings.',
        },
      ],
    },
    {
      id: 'accessing-correcting-downloading',
      number: '3',
      title: 'Accessing, correcting, or downloading your personal information',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You have the right to request access to the personal information crowd4test holds about you. Unless an exception applies, we must allow you to see the personal information we hold about you, within a reasonable time period, and without unreasonable expense for no charge. Most personal information can be accessed by logging into your account. If you wish to access information that is not accessible through the platform, or wish to download all personal information we hold on you in a portable data format, please contact our Privacy Officer at info@crowd4test.com You also have the right to request the correction of the personal information we hold about you. All your personal information can be updated through the user settings pages. If you require assistance please contact our customer support at info@crowd4test.com',
        },
      ],
    },
    {
      id: 'contact-our-privacy-officer',
      number: '4',
      title: 'To contact our Privacy Officer',
      blocks: [
        {
          kind: 'paragraph',
          text: 'If you have an enquiry or a complaint about the way we handle your personal information, or to seek to exercise your privacy rights in relation to the personal information we hold about you, you may contact our Privacy Officer as follows:',
        },
        { kind: 'paragraph', text: 'By Email:' },
        { kind: 'paragraph', text: 'info@crowd4test.com' },
      ],
    },
  ],
}
