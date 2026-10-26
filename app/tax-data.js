/* Duitful — LHDN tax relief data. THIS IS THE FILE TO UPDATE EVERY BUDGET.
 *
 * The body below is plain JSON (a test checks that). To roll in a new Budget,
 * paste the new schedule over the object after `const TAX_DATA =` and keep the
 * `;` at the end. No other file needs to change:
 *
 *   - Limits are `limit_ya_<year>_myr` on each item. Add `limit_ya_2028_myr`
 *     etc. A year with no key of its own uses the nearest EARLIER year's value;
 *     a year before the first key uses the first; `null` means "no relief that
 *     year" (discontinued).
 *   - Sub-limits (`sub_limits`) sit INSIDE their item's cap. Each takes an
 *     `id` (stable — saved claims point at it), `limit_myr`, and optionally
 *     `since_ya` / `until_ya` (first / last year it exists).
 *   - `income_tax_by_ya` holds the rate bands and the rebate; same
 *     nearest-earlier rule. `up_to: null` is the top, open-ended band.
 *   - `filing_by_ya` holds the dates the app works to, as "MM-DD", same
 *     nearest-earlier rule. For YA <year>: `november_check` falls in <year>;
 *     `final_check` (the last reminder before filing season), `efiling_opens`
 *     and `deadline` (the date people are told they can add receipts by) fall
 *     in <year>+1. `keep_records_years` is how long LHDN can ask for records.
 *   - `code` (A1, B1 …) must stay unique and should not be renumbered.
 *   - Optional `app` block per item: `id` (stable internal id; defaults to the
 *     lower-cased code), `label` (short name for the UI), `common` (nudge
 *     people about unused room), `keywords` (a regex source that makes
 *     matching spending suggest this relief), and `auto` for reliefs given
 *     without a receipt: individual, spouse, disabledSelf, disabledSpouse,
 *     child, childPre, childTertiary, disabledChild.
 *   - A brand-new relief with no `app.keywords` still appears — in the claim
 *     dialog, the reliefs list and the export — it just isn't auto-suggested.
 *
 * Not all of this schedule is verified against LHDN: check it when you paste.
 */
const TAX_DATA = {
 "$schema": "https://json-schema.org/draft/2020-12/schema",
 "title": "Malaysian Individual Personal Tax Reliefs - Detailed Itemized Breakdown (YA 2026 & YA 2027)",
 "country": "Malaysia",
 "tax_authority": "Lembaga Hasil Dalam Negeri Malaysia (LHDN)",
 "income_tax_by_ya": {
  "2026": {
   "rebate": {
    "amount": 400,
    "chargeable_income_up_to": 35000
   },
   "bands": [
    {
     "up_to": 5000,
     "rate": 0
    },
    {
     "up_to": 20000,
     "rate": 0.01
    },
    {
     "up_to": 35000,
     "rate": 0.03
    },
    {
     "up_to": 50000,
     "rate": 0.06
    },
    {
     "up_to": 70000,
     "rate": 0.11
    },
    {
     "up_to": 100000,
     "rate": 0.19
    },
    {
     "up_to": 400000,
     "rate": 0.25
    },
    {
     "up_to": 600000,
     "rate": 0.26
    },
    {
     "up_to": 2000000,
     "rate": 0.28
    },
    {
     "up_to": null,
     "rate": 0.3
    }
   ]
  }
 },
 "filing_by_ya": {
  "2026": {
   "november_check": "11-15",
   "final_check": "02-20",
   "efiling_opens": "03-01",
   "deadline": "05-15",
   "deadline_note": "BE form via e-Filing (30 April, plus LHDN's 15-day e-Filing grace)",
   "keep_records_years": 7
  }
 },
 "tax_relief_categories": [
  {
   "category_id": "CAT_INDIVIDUAL_BASIC",
   "category_name": "Individual & Basic Reliefs",
   "items": [
    {
     "code": "A1",
     "name": "Automatic Individual & Dependent Relatives Relief",
     "limit_ya_2026_myr": 9000,
     "limit_ya_2027_myr": 12000,
     "sub_limits": null,
     "claimable_items": [
      "Automatic baseline tax deduction for resident individuals in Malaysia"
     ],
     "eligibility_criteria": "Granted automatically to every resident individual taxpayer upon filing tax returns.",
     "required_documentation": "None (automatic)",
     "app": {
      "auto": "individual"
     }
    },
    {
     "code": "A2",
     "name": "Disabled Individual Relief",
     "limit_ya_2026_myr": 7000,
     "limit_ya_2027_myr": 7000,
     "sub_limits": null,
     "claimable_items": [
      "Additional flat relief for certified disabled individuals"
     ],
     "eligibility_criteria": "Taxpayer must be certified as a disabled person by the Department of Social Welfare (JKM).",
     "required_documentation": "JKM disability card / registration document",
     "app": {
      "auto": "disabledSelf"
     }
    },
    {
     "code": "A3",
     "name": "Basic Supporting Equipment",
     "limit_ya_2026_myr": 6000,
     "limit_ya_2027_myr": 6000,
     "sub_limits": null,
     "claimable_items": [
      "Wheelchairs",
      "Hemodialysis machines",
      "Hearing aids",
      "Artificial limbs",
      "Prosthetics and orthopedic braces",
      "Other necessary basic supporting equipment for disabled self, spouse, child, or parent"
     ],
     "eligibility_criteria": "Purchased for self, spouse, child, or parent who is registered disabled with JKM or certified disabled by a medical practitioner.",
     "required_documentation": "Official tax receipts, purchase invoices, and JKM registration card / medical practitioner certificate",
     "app": {
      "id": "supporting",
      "label": "Disability support equipment"
     }
    }
   ]
  },
  {
   "category_id": "CAT_PARENTS_GRANDPARENTS",
   "category_name": "Parents & Grandparents Care",
   "items": [
    {
     "code": "B1",
     "name": "Medical, Healthcare & Care Expenses for Parents / Grandparents",
     "limit_ya_2026_myr": 8000,
     "limit_ya_2027_myr": 8000,
     "sub_limits": [
      {
       "id": "checkup",
       "sub_category": "Full Body Checkup & Vaccinations for Parents/Grandparents",
       "limit_myr": 1000
      }
     ],
     "claimable_items": [
      "Medical treatments at private clinics, hospitals, or nursing homes",
      "Non-cosmetic dental treatments (extractions, fillings, root canals, dentures)",
      "Full body medical checkups for parents/grandparents (max RM1,000)",
      "NPRA-registered vaccinations for parents/grandparents (max RM1,000)",
      "Care services provided by registered daycare centres or nursing homes",
      "Carer expenses for parents/grandparents (certified home nursing)",
      "Over-the-counter medical supplies and nutritional supplements prescribed by a doctor"
     ],
     "eligibility_criteria": "For parents residing in Malaysia. In YA 2027, scope expands to include grandparents and general eldercare services without requiring strict medical doctor certification.",
     "required_documentation": "Official receipts from registered clinics/hospitals/daycare centres, prescription letters, and carer work permits/contract (if applicable)",
     "app": {
      "id": "medparents",
      "label": "Parents' & grandparents' care"
     }
    }
   ]
  },
  {
   "category_id": "CAT_MEDICAL_HEALTHCARE",
   "category_name": "Medical, Healthcare & Well-Being (Self, Spouse, Child)",
   "items": [
    {
     "code": "C1",
     "name": "Medical Expenses for Self, Spouse, or Child",
     "limit_ya_2026_myr": 10000,
     "limit_ya_2027_myr": 10000,
     "sub_limits": [
      {
       "id": "checkup",
       "sub_category": "Complete Health Examination, Mental Health Consultations & Diagnostic Kits",
       "limit_myr": 1000
      },
      {
       "id": "dental",
       "sub_category": "Dental Treatments (Non-cosmetic)",
       "limit_myr": 1000
      },
      {
       "id": "vaccine",
       "sub_category": "Vaccinations (NPRA-registered)",
       "limit_myr": 1000
      },
      {
       "id": "fertility",
       "sub_category": "Fertility Treatments (IVF, IUI, ICSI)",
       "limit_myr": 10000
      },
      {
       "id": "postnatal",
       "sub_category": "Postnatal Care Services (New in YA 2027)",
       "limit_myr": 3000,
       "since_ya": 2027
      },
      {
       "id": "breastfeeding",
       "sub_category": "Breastfeeding Equipment (Integrated in YA 2027)",
       "limit_myr": 1000,
       "since_ya": 2027
      }
     ],
     "claimable_items": [
      "Serious disease treatments (cancer, heart disease, kidney failure, leukemia, major organ transplant, severe burns, etc.)",
      "Fertility treatments (IVF, IUI, ICSI) for legally married couples",
      "Routine full-body health screenings and blood tests",
      "Psychiatric and psychological consultations, therapy, and mental health screenings",
      "Self-testing kits (COVID-19 rapid tests, blood glucose monitors, blood pressure monitors)",
      "Non-cosmetic dental treatments (tooth extractions, fillings, scaling, root canals, crowns, bridge installations)",
      "NPRA-registered vaccines (HPV, Influenza, Pneumococcal, Hepatitis, Rotavirus, Shingles, COVID-19 booster)",
      "Registered confinement center fees or qualified home postnatal care services (max RM3,000 for YA 2027)",
      "Breastfeeding equipment (breast pumps, ice packs, milk storage bags, cooler bags for children aged 2 years and under - claimable once every 2 years)"
     ],
     "eligibility_criteria": "Expenses incurred for self, legal spouse, or biological/adopted children.",
     "required_documentation": "Official clinic/hospital tax receipts, itemized invoices, test reports, and registered doctor certificates",
     "app": {
      "id": "medical",
      "label": "Medical (self, spouse, child)"
     }
    },
    {
     "code": "C2",
     "name": "Learning Disability Support / Special Needs Child",
     "limit_ya_2026_myr": 10000,
     "limit_ya_2027_myr": 10000,
     "sub_limits": null,
     "claimable_items": [
      "Diagnostic assessment expenses conducted by registered medical practitioners",
      "Early intervention program fees",
      "Rehabilitation therapy (occupational therapy, speech therapy, sensory integration therapy)",
      "Special education tuition and specialized training classes"
     ],
     "eligibility_criteria": "For children aged 18 and below diagnosed with Autism Spectrum Disorder (ASD), Attention Deficit Hyperactivity Disorder (ADHD), Down Syndrome, Dyslexia, or Global Developmental Delay (GDD).",
     "required_documentation": "Diagnostic report from registered specialist doctor, official tuition/therapy receipts, and practitioner registration details",
     "app": {
      "id": "learning",
      "label": "Learning-disability support (child)"
     }
    },
    {
     "code": "C3",
     "name": "Breastfeeding Equipment (standalone, to YA 2026)",
     "limit_ya_2026_myr": 1000,
     "limit_ya_2027_myr": null,
     "sub_limits": null,
     "claimable_items": [
      "Breastfeeding equipment (breast pumps, ice packs, milk storage bags, cooler bags for children aged 2 years and under - claimable once every 2 years)"
     ],
     "eligibility_criteria": "Once every two years. From YA 2027 this is a sub-limit of C1.",
     "required_documentation": "Official purchase receipts",
     "app": {
      "id": "breastfeeding",
      "label": "Breastfeeding equipment"
     }
    }
   ]
  },
  {
   "category_id": "CAT_FAMILY_CHILDREN",
   "category_name": "Family & Children Reliefs",
   "items": [
    {
     "code": "D1",
     "name": "Spouse Relief / Alimony to Ex-Wife",
     "limit_ya_2026_myr": 4000,
     "limit_ya_2027_myr": 4000,
     "sub_limits": null,
     "claimable_items": [
      "Basic spouse relief when spouse has no income source or elects joint assessment",
      "Alimony payments to ex-wife"
     ],
     "eligibility_criteria": "Spouse has no income, or elects joint tax assessment under taxpayer. Alimony must be supported by a formal legal separation/divorce court agreement.",
     "required_documentation": "Marriage certificate, formal legal agreement for alimony, and bank transfer receipts",
     "app": {
      "auto": "spouse"
     }
    },
    {
     "code": "D2",
     "name": "Disabled Spouse Relief",
     "limit_ya_2026_myr": 6000,
     "limit_ya_2027_myr": 6000,
     "sub_limits": null,
     "claimable_items": [
      "Additional relief for a certified disabled spouse"
     ],
     "eligibility_criteria": "Spouse registered as a disabled person with JKM.",
     "required_documentation": "JKM disability card of spouse",
     "app": {
      "auto": "disabledSpouse"
     }
    },
    {
     "code": "D3",
     "name": "Child Relief (Under 18 Years)",
     "limit_ya_2026_myr": 2000,
     "limit_ya_2027_myr": 2000,
     "sub_limits": null,
     "claimable_items": [
      "Per unmarried child under 18 years of age at any time during the basis year"
     ],
     "eligibility_criteria": "Unmarried biological, step-child, or legally adopted child under 18.",
     "required_documentation": "Child's birth certificate / MyKid",
     "app": {
      "auto": "child"
     }
    },
    {
     "code": "D4",
     "name": "Child Relief (18+ in Pre-University / A-Levels / Diploma)",
     "limit_ya_2026_myr": 2000,
     "limit_ya_2027_myr": 2000,
     "sub_limits": null,
     "claimable_items": [
      "Per unmarried child aged 18 and above receiving full-time secondary education, matriculation, A-Levels, STPM, or foundation diploma"
     ],
     "eligibility_criteria": "Unmarried child studying full-time at pre-university or diploma level.",
     "required_documentation": "Student enrollment confirmation letter from school/college",
     "app": {
      "auto": "childPre"
     }
    },
    {
     "code": "D5",
     "name": "Child Relief (18+ in Tertiary Education / Degree or Higher)",
     "limit_ya_2026_myr": 8000,
     "limit_ya_2027_myr": 8000,
     "sub_limits": null,
     "claimable_items": [
      "Per unmarried child studying full-time at Bachelor's Degree, Master's, Doctorate (PhD), or professional qualification level"
     ],
     "eligibility_criteria": "Studying at recognized higher education institutions in Malaysia or overseas.",
     "required_documentation": "Student ID card, course enrollment letter, and university fee receipts",
     "app": {
      "auto": "childTertiary"
     }
    },
    {
     "code": "D6",
     "name": "Disabled Child Relief",
     "limit_ya_2026_myr": 6000,
     "limit_ya_2027_myr": 6000,
     "sub_limits": null,
     "claimable_items": [
      "Per unmarried disabled child certified by JKM (Increases to RM14,000 total if child pursues tertiary degree level)"
     ],
     "eligibility_criteria": "Child registered with JKM.",
     "required_documentation": "JKM disability card and university enrollment verification (if claiming RM14,000)",
     "app": {
      "auto": "disabledChild"
     }
    },
    {
     "code": "D7",
     "name": "Childcare & Kindergarten Fees",
     "limit_ya_2026_myr": 3000,
     "limit_ya_2027_myr": 3000,
     "sub_limits": null,
     "claimable_items": [
      "Monthly childcare fees at registered child care centres (Taska)",
      "Kindergarten (Tadika) tuition fees",
      "Registered transit after-school daycare centre fees"
     ],
     "eligibility_criteria": "For children aged up to 12 years. Centre must be registered with JKM or MOE. Can be claimed by either father or mother (not split beyond RM3,000 combined per child).",
     "required_documentation": "Official monthly receipts issued by registered childcare centres / kindergartens with registration number",
     "app": {
      "id": "childcare",
      "label": "Childcare & kindergarten fees"
     }
    },
    {
     "code": "D8",
     "name": "SSPN Net Savings Deposit",
     "limit_ya_2026_myr": 8000,
     "limit_ya_2027_myr": 8000,
     "sub_limits": null,
     "claimable_items": [
      "Net annual deposits into Skim Simpanan Pendidikan Nasional (SSPN-i / SSPN-i Plus) accounts for biological or legally adopted children"
     ],
     "eligibility_criteria": "Claimed amount is calculated as Total Deposits minus Total Withdrawals made during the calendar year.",
     "required_documentation": "Annual SSPN Statement of Account issued by PTPTN",
     "app": {
      "id": "sspn",
      "label": "SSPN (child savings)",
      "common": true
     }
    }
   ]
  },
  {
   "category_id": "CAT_EDUCATION_SKILLS",
   "category_name": "Education & Self-Upskilling",
   "items": [
    {
     "code": "E1",
     "name": "Education Fees for Self",
     "limit_ya_2026_myr": 7000,
     "limit_ya_2027_myr": 7000,
     "sub_limits": [
      {
       "id": "upskill",
       "sub_category": "Personal Upskilling & Technical/Vocational Courses",
       "limit_myr": 2000
      },
      {
       "id": "tvet",
       "sub_category": "TVET Skill Improvement Courses (YA 2027 expansion)",
       "limit_myr": 3000,
       "since_ya": 2027
      },
      {
       "id": "tuition",
       "sub_category": "Children Special Tuition/Classes (YA 2027 expansion - STEM, Languages, Religion)",
       "limit_myr": 2000,
       "since_ya": 2027
      }
     ],
     "claimable_items": [
      "Master's or PhD degree tuition fees (any field of study)",
      "Diploma, Bachelor's Degree, or Professional qualifications (ACCA, CIMA, CFA, CLP, Bar, etc.) in Law, Accounting, Technical, Vocational, Industrial, Information Technology, STEM, or Islamic Finance",
      "Short courses for self-upskilling/reskilling approved by the Department of Skills Development (JPK)",
      "In YA 2027: Expanded to higher education in any field, TVET courses (max RM3,000), and tuition fees for children in STEM, foreign languages, arts, or religious studies (max RM2,000)"
     ],
     "eligibility_criteria": "Course undertaken at recognized local institutions or professional bodies.",
     "required_documentation": "Tuition fee receipts, course registration slips, and accreditation certificates",
     "app": {
      "id": "education",
      "label": "Education fees (own)"
     }
    }
   ]
  },
  {
   "category_id": "CAT_LIFESTYLE_SPORTS_SUSTAINABILITY",
   "category_name": "Lifestyle, Sports, Sustainable Living & Tourism",
   "items": [
    {
     "code": "F1",
     "name": "General Lifestyle Relief",
     "limit_ya_2026_myr": 2500,
     "limit_ya_2027_myr": 2500,
     "sub_limits": [
      {
       "id": "ai",
       "sub_category": "Artificial Intelligence (AI) Software Subscriptions (New in YA 2027)",
       "limit_myr": 2500,
       "since_ya": 2027
      },
      {
       "id": "pet",
       "sub_category": "Pet Shelter Adoption & Veterinary Care (New in YA 2027)",
       "limit_myr": 2500,
       "since_ya": 2027
      }
     ],
     "claimable_items": [
      "Books, printed journals, physical magazines, and digital e-books (excluding prohibited publication materials)",
      "Personal computers, laptops, smartphones, and tablets (not for commercial business use)",
      "Monthly subscriptions for home broadband internet (registered under taxpayer's name)",
      "Self-enhancement skill acquisition courses",
      "In YA 2027: AI software subscriptions (e.g. ChatGPT Plus, Midjourney, Claude, Copilot)",
      "In YA 2027: Pet adoption fees paid to registered animal shelters, plus veterinary services (vaccinations, spaying, neutering, health treatments)"
     ],
     "eligibility_criteria": "Items purchased for self, spouse, or children.",
     "required_documentation": "Official tax receipts, electronic invoices, or monthly internet statements",
     "app": {
      "id": "lifestyle",
      "label": "Lifestyle",
      "common": true
     }
    },
    {
     "code": "F2",
     "name": "Sports Equipment & Activity Relief",
     "limit_ya_2026_myr": 1000,
     "limit_ya_2027_myr": 1000,
     "sub_limits": [
      {
       "id": "shoes",
       "sub_category": "Sports Shoes (New in YA 2027)",
       "limit_myr": 300,
       "since_ya": 2027
      }
     ],
     "claimable_items": [
      "Purchase of sports equipment for sports listed under the Sports Development Act 1997 (rackets, balls, bicycles, swimming gear, etc.)",
      "Rental fees for sports facilities and court bookings (badminton, futsal, tennis, etc.)",
      "Entrance fees or registration fees for sports competitions (marathons, cycling events, tournaments)",
      "Gym membership fees and personal fitness trainer packages",
      "In YA 2027: Sports shoes / running shoes (capped at RM300 within the overall RM1,000 limit)"
     ],
     "eligibility_criteria": "Sports items and activities must fall under the Sports Development Act 1997.",
     "required_documentation": "Official purchase receipts, gym membership tax invoices, and event registration receipts",
     "app": {
      "id": "sports",
      "label": "Sports & gym",
      "common": true
     }
    },
    {
     "code": "F3",
     "name": "EV Charging, Food Waste Equipment & Home Security CCTV",
     "limit_ya_2026_myr": 2500,
     "limit_ya_2027_myr": 2500,
     "sub_limits": null,
     "claimable_items": [
      "Electric Vehicle (EV) home charger equipment purchase, installation, maintenance, or monthly subscription fees",
      "Food waste composting machines and food waste disposal units",
      "Home Closed-Circuit Television (CCTV) security system equipment and installation"
     ],
     "eligibility_criteria": "Claimable once every 2 years for EV facilities and home CCTV systems.",
     "required_documentation": "Tax invoice and installation service receipts under taxpayer's name",
     "app": {
      "id": "ev",
      "label": "EV charging, food-waste & home CCTV"
     }
    },
    {
     "code": "F4",
     "name": "Domestic Tourism & Cultural Events",
     "limit_ya_2026_myr": 1000,
     "limit_ya_2027_myr": 1000,
     "sub_limits": null,
     "claimable_items": [
      "Entrance tickets to local registered tourist attractions, heritage sites, national parks, and museums",
      "Entrance fees to local arts, musical, and cultural performances"
     ],
     "eligibility_criteria": "Incurred within Malaysia for registered tourism places or events.",
     "required_documentation": "Official entrance tickets and digital payment receipts",
     "app": {
      "id": "tourism",
      "label": "Domestic tourism & culture"
     }
    }
   ]
  },
  {
   "category_id": "CAT_INSURANCE_EPF_RETIREMENT",
   "category_name": "Insurance, EPF & Social Protection",
   "items": [
    {
     "code": "G1",
     "name": "EPF / Approved Pension Scheme",
     "limit_ya_2026_myr": 4000,
     "limit_ya_2027_myr": 4000,
     "sub_limits": null,
     "claimable_items": [
      "Mandatory statutory employee EPF contributions",
      "Voluntary self-contributions into EPF (i-Saraan, self-employed contributions)"
     ],
     "eligibility_criteria": "Contributions made to EPF or any approved pension fund.",
     "required_documentation": "Annual EA Form or EPF Annual Statement",
     "app": {
      "id": "epf",
      "label": "EPF (yours + voluntary)",
      "common": true,
      "employeeEpf": true
     }
    },
    {
     "code": "G2",
     "name": "Life Insurance & Family Takaful",
     "limit_ya_2026_myr": 3000,
     "limit_ya_2027_myr": 3000,
     "sub_limits": null,
     "claimable_items": [
      "Life insurance premium payments",
      "Family takaful contributions",
      "Additional voluntary EPF contributions (if life insurance cap is underutilized)"
     ],
     "eligibility_criteria": "Policy covering self, legal spouse, or children.",
     "required_documentation": "Annual Life Insurance / Takaful Premium Statement",
     "app": {
      "id": "lifeins",
      "label": "Life insurance / family takaful",
      "common": true
     }
    },
    {
     "code": "G3",
     "name": "Education & Medical Insurance",
     "limit_ya_2026_myr": 3000,
     "limit_ya_2027_myr": 3000,
     "sub_limits": null,
     "claimable_items": [
      "Medical insurance policy premiums (hospitalization & surgical coverage)",
      "Education insurance policy premiums for children",
      "Riders attached to medical policies covering critical illness and hospital stay costs"
     ],
     "eligibility_criteria": "Policies benefiting self, spouse, or children.",
     "required_documentation": "Annual Medical & Education Insurance Premium Statement",
     "app": {
      "id": "insurance",
      "label": "Education & medical insurance",
      "common": true
     }
    },
    {
     "code": "G4",
     "name": "SOCSO (PERKESO) / EIS Protection",
     "limit_ya_2026_myr": 350,
     "limit_ya_2027_myr": 500,
     "sub_limits": [
      {
       "id": "voluntary",
       "sub_category": "Voluntary Lindung 24 Jam / Lindung Kendiri Protection (YA 2027 expansion)",
       "limit_myr": 150,
       "since_ya": 2027
      }
     ],
     "claimable_items": [
      "Mandatory employee contributions to SOCSO (PERKESO)",
      "Mandatory contributions to Employment Insurance System (EIS)",
      "Self-employed / gig worker contributions under Self-Employment Social Security Scheme (SKSPS)",
      "In YA 2027: Additional RM150 relief specifically for voluntary SOCSO protection schemes (Lindung 24 Jam)"
     ],
     "eligibility_criteria": "Contributions deducted from salary or paid voluntarily under SKSPS.",
     "required_documentation": "EA Form / SOCSO SKSPS payment receipts",
     "app": {
      "id": "socso",
      "label": "SOCSO / EIS"
     }
    },
    {
     "code": "G5",
     "name": "Private Retirement Scheme (PRS) & Deferred Annuity",
     "limit_ya_2026_myr": 3000,
     "limit_ya_2027_myr": 3000,
     "sub_limits": null,
     "claimable_items": [
      "Contributions into approved Private Retirement Schemes (PRS)",
      "Premium payments for deferred annuity plans"
     ],
     "eligibility_criteria": "Tax relief extended until Year of Assessment 2030.",
     "required_documentation": "Annual PPA (Private Pension Administrator) contribution statement",
     "app": {
      "id": "prs",
      "label": "PRS / deferred annuity",
      "common": true
     }
    }
   ]
  },
  {
   "category_id": "CAT_FIRST_HOME_INTEREST",
   "category_name": "First-Home Housing Loan Interest Relief",
   "items": [
    {
     "code": "H1",
     "name": "First-Home Mortgage Housing Loan Interest Relief",
     "limit_ya_2026_myr": 7000,
     "limit_ya_2027_myr": 7000,
     "sub_limits": [
      {
       "id": "low",
       "sub_category": "Residential property valued up to RM500,000",
       "limit_myr": 7000
      },
      {
       "id": "mid",
       "sub_category": "Residential property valued between RM500,001 and RM750,000",
       "limit_myr": 5000
      }
     ],
     "claimable_items": [
      "Housing loan interest paid on first residential home purchase"
     ],
     "eligibility_criteria": "Claimable for 3 consecutive assessment years starting from the year housing loan interest payment commences. Sale and Purchase Agreement (SPA) must be executed between 1 January 2025 and 31 December 2027. Property must not be rented out for income generation.",
     "required_documentation": "Executed Sales & Purchase Agreement (SPA) and annual housing loan interest statement issued by financing institution",
     "app": {
      "id": "housing",
      "label": "First-home loan interest"
     }
    }
   ]
  }
 ]
};
