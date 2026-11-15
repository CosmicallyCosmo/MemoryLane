package com.memorylane.glasses

/**
 * "Who is that?" about a memory, answered from what the family said about it. Nobody is
 * recognised by their face: the answer comes only from who the family said is in the memory,
 * their names and how they are related to the wearer.
 */

/**
 * "Who is that ...?", "Who's the girl ...?". Only these openings ask who someone is: "Who is
 * coming on Sunday?" is a question for the family's recorded answers.
 */
private val WHO_ASKED = Regex("^who(?:'s|s| is| was| are) ((?:that|this|the|he|she|it|they|you|him|her)\\b.*)$")

/** Words that say nothing about which person is meant. */
private val FILLER =
    setOf(
        "that", "this", "the", "there", "here", "it", "is", "a", "an", "my", "your", "our", "person",
        "one", "then", "now", "again", "please", "in", "on", "of", "at", "picture", "photo",
        "photograph", "memory", "from", "oh", "they", "them", "these", "those", "people", "you",
        "lovely", "nice", "dear", "darling", "sweet", "pretty", "handsome", "beautiful", "gorgeous",
        "wonderful", "special", "family", "relative", "member",
    )

/** Past these, the wearer is describing someone else ("the one with Jake"). */
private val RELATION_WORDS = setOf("with", "and", "next", "beside", "behind", "near", "holding", "by", "carrying", "hugging")

private val MALE =
    setOf(
        "he", "him", "his", "himself", "man", "men", "boy", "lad", "laddie", "guy", "gent", "gentleman",
        "chap", "fellow", "fella", "bloke", "mister", "sir", "male", "dude",
    )
private val FEMALE =
    setOf(
        "she", "her", "hers", "herself", "woman", "women", "girl", "lass", "lassie", "lady", "gal", "miss",
        "madam", "female",
    )

/** How old they would look beside the wearer, in a photograph of any year. */
private val YOUNGER =
    setOf("young", "younger", "youngster", "kid", "kiddie", "child", "little", "small", "baby", "toddler", "teenager", "teen", "youth", "junior")
private val OLDER = setOf("old", "older", "elderly", "aged", "senior")

private val CHILD = setOf("child", "children", "kid", "kids", "offspring")
private val GRANDCHILD = setOf("grandchild", "grandchildren", "grandkid", "grandkids")
private val PARENT = setOf("parent", "parents")
private val GRANDPARENT = setOf("grandparent", "grandparents")
private val SIBLING = setOf("sibling", "siblings")
private val SPOUSE = setOf("spouse", "partner")

/**
 * One kind of relative: what the family might write for it, and with them every word the
 * wearer might use for someone of that kind.
 */
private class Kin(val names: Set<String>, gender: Set<String>, age: Set<String> = emptySet(), groups: Set<String> = emptySet()) {
  val words: Set<String> = names + gender + age + groups
}

private val KIN =
    listOf(
        Kin(setOf("son", "sonny"), MALE, YOUNGER, CHILD),
        Kin(setOf("daughter"), FEMALE, YOUNGER, CHILD),
        Kin(setOf("grandson"), MALE, YOUNGER, GRANDCHILD),
        Kin(setOf("granddaughter"), FEMALE, YOUNGER, GRANDCHILD),
        Kin(setOf("mother", "mum", "mom", "mam", "ma", "mummy", "mommy", "mama", "mamma", "mammy"), FEMALE, OLDER, PARENT),
        Kin(setOf("father", "dad", "daddy", "da", "pa", "papa", "pop", "pops"), MALE, OLDER, PARENT),
        Kin(
            setOf("grandmother", "grandma", "gran", "granny", "grannie", "nan", "nana", "nanna", "nanny", "grandmum", "grandmom", "nonna", "oma"),
            FEMALE,
            OLDER,
            GRANDPARENT,
        ),
        Kin(
            setOf("grandfather", "grandpa", "grandad", "granddad", "gramps", "grampa", "grandpop", "nonno", "opa"),
            MALE,
            OLDER,
            GRANDPARENT,
        ),
        Kin(setOf("husband", "hubby"), MALE, groups = SPOUSE),
        Kin(setOf("wife", "missus", "missis"), FEMALE, groups = SPOUSE),
        Kin(setOf("brother", "bro"), MALE, groups = SIBLING),
        Kin(setOf("sister", "sis"), FEMALE, groups = SIBLING),
        Kin(setOf("uncle"), MALE, OLDER),
        Kin(setOf("aunt", "auntie", "aunty"), FEMALE, OLDER),
        Kin(setOf("nephew"), MALE, YOUNGER),
        Kin(setOf("niece"), FEMALE, YOUNGER),
        Kin(setOf("boyfriend", "fiance"), MALE, groups = setOf("partner")),
        Kin(setOf("girlfriend", "fiancee"), FEMALE, groups = setOf("partner")),
        Kin(setOf("cousin"), emptySet()),
        Kin(setOf("friend", "pal", "mate", "buddy", "chum"), emptySet()),
        Kin(setOf("neighbour", "neighbor"), emptySet()),
        Kin(setOf("partner"), emptySet(), groups = SPOUSE),
    )

private fun words(text: String) = text.lowercase().replace("’", "'").split(Regex("[^a-z']+")).filter { it.isNotEmpty() }

/** Every word that could pick this person out: their name, and every word for how they are related. */
private fun identifiers(person: Person): Set<String> {
  // "Stepson" is a son, "son-in-law" a son, "great-grandson" a grandson.
  val relation = words(person.relationship).map { it.removePrefix("step") }
  return words(person.name).toSet() + relation + relation.flatMap { r -> KIN.firstOrNull { r in it.names }?.words.orEmpty() }
}

/** What a "who is that ...?" question says about the person ("that girl"), or null if it is not one. */
fun whoDescription(lower: String): String? = WHO_ASKED.find(lower.trim())?.groupValues?.get(1)

/**
 * The person meant by a "who is that ...?" question about a memory, or null when it is not
 * clear. Nothing said beyond "who is that" means the person whose memory it is, [owner]. Said
 * more ("the little girl", "my son", "Jake"), it is whoever of [people] alone fits every word
 * of it. If more than one fits, or a word is one nothing is known about ("the one in the
 * hat"), nobody is named: the wearer is told it is not known rather than given a guess.
 */
fun whoIsMeant(description: String, people: List<Person>, owner: Person?): Person? {
  val said = words(description)
  val cut = said.indexOfFirst { it in RELATION_WORDS }
  val about = (if (cut >= 0) said.take(cut) else said).filter { it !in FILLER }
  if (about.isEmpty()) {
    // "Who's that with Jake?" asks about someone else; who that is cannot be told.
    return if (cut >= 0 && said.drop(cut + 1).any { it !in FILLER }) null else owner
  }
  return people
      .filter { person -> identifiers(person).let { ids -> about.all { it in ids || it.removeSuffix("s") in ids } } }
      .singleOrNull()
}
